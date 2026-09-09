import { resolveContextBudget } from './context-budget.js';
import { codingAgentContext } from './agent-context.js';
import { archiveToolRuntime } from './archive.js';
import { createHarness } from './host.js';
import { conversationalLoop, planningLoop, codingToolRuntime, defaultCodingPolicy } from './defaults.js';
import { createSqliteSessionStore, MemorySessionStore } from './stores.js';
import type { ExecutionLimits } from '../ExecutionOptions.js';
import type { Extension, SessionClient } from './types.js';
import { readProjectInstructions } from './instructions.js';
import { realpathSync } from 'node:fs';
import { SqliteMemoryStore } from '../SqliteMemoryStore.js';
import { CompositeToolRuntime } from '../../tools/composite.js';
import { memoryToolRuntime, sessionNoteSource } from './memory.js';
import type { SubscriptionProviderOptions } from '../../providers/subscription.js';

export interface DefaultAgentOptions {
    workspace: string;
    model?: string;
    /** Subscription provider reasoning effort. Defaults to low. */
    reasoningEffort?: SubscriptionProviderOptions['reasoningEffort'];
    authFilePath?: string;
    database?: string;
    /** Opt in to source-backed workspace notes and explicit recall tools. */
    memoryDatabase?: string;
    planning?: boolean;
    /** Optional working-context cap; defaults to the provider model capacity. */
    tokenBudget?: number;
    /** Complete-line read page ceiling in bytes. Defaults to the coding pack's 16000. */
    textPageBytes?: number;
    /** Exclude workspace edits and command execution from the coding toolset. */
    readOnly?: boolean;
    /** Reserved inside tokenBudget and sent as the provider output limit. Default: 4096. */
    outputTokens?: number;
    limits?: ExecutionLimits;
    system?: string;
    extensions?: Extension[];
    /** Select scoped AGENTS.md directories explicitly; otherwise discover workspace scopes. */
    instructionDirectories?: string[];
}
/** A reference composition; the empty host itself installs none of these services. */
export async function defaultAgentExtensions(options: DefaultAgentOptions): Promise<Extension[]> {
    let client: SessionClient | undefined;
    const model = options.model ?? 'gpt-6-astra';
    const reasoningEffort = options.reasoningEffort ?? 'low';
    await readProjectInstructions(options.workspace, options.instructionDirectories);
    const provider = new (await import('../../providers/subscription.js')).SubscriptionProvider({ model, authFilePath: options.authFilePath, reasoningEffort });
    const tokenBudget = resolveContextBudget(provider, options.tokenBudget);
    return [
        { id: 'sessions.local', version: '6.0.0', apiVersion: 1, roles: { store: () => options.database ? createSqliteSessionStore(options.database) : new MemorySessionStore() } },
        { id: options.planning ? 'loop.planning' : 'loop.conversational', version: '4.0.0', apiVersion: 1,
            configuration: JSON.stringify({ outputTokens: options.outputTokens ?? 4096 }),
            roles: { loop: () => options.planning ? planningLoop({ maxTokens: options.outputTokens ?? 4096 }) : conversationalLoop({ maxTokens: options.outputTokens ?? 4096 }) } },
        { id: 'context.budgeted', configuration: JSON.stringify({ system: options.system ?? null, workspace: options.workspace, instructionDirectories: options.instructionDirectories ?? null, budget: tokenBudget }), version: '19.0.0', apiVersion: 1, roles: { context: () => codingAgentContext({ ...options, tokenBudget }) } },
        { id: `provider.subscription.${model}`, version: '6.0.0', apiVersion: 1,
            configuration: provider.configurationIdentity,
            roles: { provider: () => provider } },
        { id: 'tools.coding', configuration: JSON.stringify({ workspace: options.workspace, outputDirectory: options.database ? `${options.database}.outputs` : null, memoryDatabase: options.memoryDatabase ?? null, textPageBytes: options.textPageBytes ?? 16000, readOnly: options.readOnly ?? false }), version: '19.0.0', apiVersion: 1,
            activate: async value => { client = value; },
            roles: { tools: async () => {
                const coding = codingToolRuntime(options.workspace, { outputDirectory: options.database ? `${options.database}.outputs` : undefined, textPageBytes: options.textPageBytes, readOnly: options.readOnly });
                const archive = archiveToolRuntime(async (sessionId, signal) => {
                    signal?.throwIfAborted();
                    if (!client) throw new Error('Archive reader is not active');
                    return (await client.get(sessionId)).messages;
                });
                if (!options.memoryDatabase) return new CompositeToolRuntime([coding, archive]);
                const store = await SqliteMemoryStore.open(options.memoryDatabase, realpathSync(options.workspace));
                try {
                    const memory = memoryToolRuntime(store, (query, signal) => {
                        if (!client) throw new Error('Memory source reader is not active');
                        return sessionNoteSource(client)(query, signal);
                    });
                    memory.close = () => store.close();
                    return new CompositeToolRuntime([coding, archive, memory]);
                } catch (error) { await store.close(); throw error; }
            } } },
        { id: 'policy.confirm-mutations', version: '1.0.0', apiVersion: 1, roles: { policy: () => defaultCodingPolicy() } },
        ...options.extensions ?? [],
    ];
}
export async function createDefaultAgent(options: DefaultAgentOptions): Promise<SessionClient> {
    return createHarness().compose({ extensions: await defaultAgentExtensions(options), limits: options.limits });
}
