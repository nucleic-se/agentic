import type { ILLMProvider } from '../../contracts/llm.js';
import { skillCatalogText, skillToolRuntime, type SkillCatalog } from '../../tools/skills.js';
import type { IValidatedToolRuntime } from '../../contracts/tool-runtime.js';
import { resolveContextBudget } from './context-budget.js';
import { codingAgentContext } from './agent-context.js';
import { archiveToolRuntime } from './archive.js';
import { createHarness } from './host.js';
import { conversationalLoop, planningLoop } from './loops.js';
import { codingToolRuntime, defaultCodingPolicy } from './coding.js';
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
    /** Borrowed application provider; the caller retains its lifecycle. Omit for subscription defaults.
     * Cannot be combined with model, reasoningEffort or authFilePath. */
    provider?: ILLMProvider;
    /** Non-secret identity override for a supplied provider; defaults to its configurationIdentity. */
    providerIdentity?: string;
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
    /** Explicit immutable skills snapshot; no discovery is performed by the preset. */
    skills?: SkillCatalog;
    /** Optional owned tool runtime, created only when the tools role is initialized. */
    additionalTools?: () => IValidatedToolRuntime | Promise<IValidatedToolRuntime>;
    /** Non-secret implementation/configuration identity, required with additionalTools. */
    additionalToolsIdentity?: string;
    /** Select scoped AGENTS.md directories explicitly; otherwise discover workspace scopes. */
    instructionDirectories?: string[];
}
/** A reference composition; the empty host itself installs none of these services. */
export async function defaultAgentExtensions(options: DefaultAgentOptions): Promise<Extension[]> {
    let client: SessionClient | undefined;
    if (options.additionalTools && !options.additionalToolsIdentity?.trim()) throw new Error('additionalTools requires additionalToolsIdentity');
    const suppliedProvider = options.provider;
    let suppliedIdentity: string | undefined;
    if (suppliedProvider !== undefined) {
        if (options.model !== undefined || options.reasoningEffort !== undefined || options.authFilePath !== undefined) {
            throw new Error('A supplied provider cannot be combined with model, reasoningEffort or authFilePath');
        }
        suppliedIdentity = options.providerIdentity ?? suppliedProvider.configurationIdentity;
        if (typeof suppliedIdentity !== 'string' || !suppliedIdentity.trim()) {
            throw new Error('A supplied provider requires a nonempty configurationIdentity or providerIdentity');
        }
    } else if (options.providerIdentity !== undefined) {
        throw new Error('providerIdentity requires a supplied provider');
    }
    const model = options.model ?? 'gpt-6-astra';
    const reasoningEffort = options.reasoningEffort ?? 'low';
    await readProjectInstructions(options.workspace, options.instructionDirectories);
    const provider = suppliedProvider ?? new (await import('../../providers/subscription.js')).SubscriptionProvider({ model, authFilePath: options.authFilePath, reasoningEffort });
    const tokenBudget = resolveContextBudget(provider, options.tokenBudget);

    async function createTools(): Promise<IValidatedToolRuntime> {
        const coding = codingToolRuntime(options.workspace, {
            outputDirectory: options.database ? `${options.database}.outputs` : undefined,
            textPageBytes: options.textPageBytes,
            readOnly: options.readOnly,
        });
        const archive = archiveToolRuntime(async (sessionId, signal) => {
            signal?.throwIfAborted();
            if (!client) throw new Error('Archive reader is not active');
            return (await client.get(sessionId)).messages;
        });
        const runtimes: IValidatedToolRuntime[] = [coding, archive];
        try {
            if (options.skills?.entries.length) runtimes.push(skillToolRuntime(options.skills));
            if (options.additionalTools) runtimes.push(await options.additionalTools());
            if (options.memoryDatabase) {
                const store = await SqliteMemoryStore.open(options.memoryDatabase, realpathSync(options.workspace));
                try {
                    const memory = memoryToolRuntime(store, (query, signal) => {
                        if (!client) throw new Error('Memory source reader is not active');
                        return sessionNoteSource(client)(query, signal);
                    });
                    memory.close = () => store.close();
                    runtimes.push(memory);
                } catch (error) {
                    await store.close();
                    throw error;
                }
            }
            return new CompositeToolRuntime(runtimes);
        } catch (error) {
            const cleanup = await Promise.allSettled([...new Set(runtimes)].map(async runtime => runtime.close?.()));
            const failures = cleanup.filter(result => result.status === 'rejected').map(result => result.reason);
            if (failures.length) throw new AggregateError([error, ...failures], 'Tool composition failed');
            throw error;
        }
    }

    return [
        {
            id: 'sessions.local',
            version: '6.0.0',
            apiVersion: 1,
            roles: {
                store: () => options.database ? createSqliteSessionStore(options.database) : new MemorySessionStore(),
            },
        },
        {
            id: options.planning ? 'loop.planning' : 'loop.conversational',
            version: '4.0.0',
            apiVersion: 1,
            configuration: JSON.stringify({ outputTokens: options.outputTokens ?? 4096 }),
            roles: {
                loop: () => options.planning
                    ? planningLoop({ maxTokens: options.outputTokens ?? 4096 })
                    : conversationalLoop({ maxTokens: options.outputTokens ?? 4096 }),
            },
        },
        {
            id: 'context.budgeted',
            configuration: JSON.stringify({
                system: options.system ?? null,
                workspace: options.workspace,
                instructionDirectories: options.instructionDirectories ?? null,
                skills: options.skills?.identity ?? null,
                budget: tokenBudget,
            }),
            version: '20.0.0',
            apiVersion: 1,
            roles: {
                context: () => codingAgentContext({
                    ...options,
                    tokenBudget,
                    additionalInstructions: options.skills ? skillCatalogText(options.skills) : undefined,
                }),
            },
        },
        {
            id: suppliedProvider === undefined ? `provider.subscription.${model}` : 'provider.application',
            version: suppliedProvider === undefined ? '6.0.0' : '1.0.0',
            apiVersion: 1,
            configuration: suppliedProvider === undefined ? provider.configurationIdentity : suppliedIdentity,
            roles: { provider: () => provider },
        },
        {
            id: 'tools.coding',
            configuration: JSON.stringify({
                workspace: options.workspace,
                outputDirectory: options.database ? `${options.database}.outputs` : null,
                memoryDatabase: options.memoryDatabase ?? null,
                textPageBytes: options.textPageBytes ?? 16000,
                readOnly: options.readOnly ?? false,
                skills: options.skills?.identity ?? null,
                additionalTools: options.additionalToolsIdentity ?? null,
            }),
            version: '20.0.0',
            apiVersion: 1,
            activate: async value => {
                client = value;
            },
            roles: { tools: createTools },
        },
        {
            id: 'policy.confirm-mutations',
            version: '2.0.0',
            apiVersion: 1,
            roles: { policy: () => defaultCodingPolicy() },
        },
        ...options.extensions ?? [],
    ];
}
export async function createDefaultAgent(options: DefaultAgentOptions): Promise<SessionClient> {
    return createHarness().compose({ extensions: await defaultAgentExtensions(options), limits: options.limits });
}
