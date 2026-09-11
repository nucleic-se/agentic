import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultAgent, defaultAgentExtensions } from './preset.js';
import type { ILLMProvider } from '../../contracts/llm.js';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { compositionFingerprint } from './composition.js';

const construct = vi.hoisted(() => vi.fn());
vi.mock('../../providers/subscription.js', () => ({ SubscriptionProvider: class {
    readonly capabilities = { contextWindowTokens: 272000 };
    readonly configurationIdentity: string;
    constructor(readonly options: { model: string; reasoningEffort: string }) {
        this.configurationIdentity = `${options.model}:${options.reasoningEffort}`;
        construct(options);
    }
} }));

it('configures reasoning without replacing the provider and preserves the default composition identity', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'preset-provider-'));
    try {
        const defaults = await defaultAgentExtensions({ workspace });
        expect(compositionFingerprint(defaults.map(extension => ({ ...extension, configuration: extension.configuration?.replaceAll(workspace, '<workspace>') })))).toBe('5fbd75cff871f1189c9d017767db436f80cdf5363f4309250f13189a61a5d31f');
        const low = await defaultAgentExtensions({ workspace, reasoningEffort: 'low' });
        const medium = await defaultAgentExtensions({ workspace, model: 'gpt-5.6-sol', reasoningEffort: 'medium' });
        expect(compositionFingerprint(defaults)).toBe(compositionFingerprint(low));
        expect(defaults.find(e => e.roles?.provider)?.configuration).toBe('gpt-6-astra:low');
        const solLow = await defaultAgentExtensions({ workspace, model: 'gpt-5.6-sol' });
        expect(compositionFingerprint(solLow)).not.toBe(compositionFingerprint(medium));
        await medium.find(e => e.roles?.provider)!.roles!.provider!();
        expect(construct).toHaveBeenCalledWith({ model: 'gpt-5.6-sol', authFilePath: undefined, reasoningEffort: 'medium' });
        await defaults.find(e => e.roles?.provider)!.roles!.provider!();
        expect(construct).toHaveBeenCalledWith({ model: 'gpt-6-astra', authFilePath: undefined, reasoningEffort: 'low' });
    } finally { await rm(workspace, { recursive: true, force: true }); }
});

function applicationProvider(identity: string | undefined = 'application-v1'): ILLMProvider & { close: ReturnType<typeof vi.fn> } {
    return {
        configurationIdentity: identity,
        capabilities: {
            contextWindowTokens: 32000,
            transport: 'fixture',
            toolBatching: true,
            outputLimit: 'enforced',
            automaticRetries: 0,
            continuation: 'message',
            requestObservation: 'none',
        },
        turn: vi.fn(async () => ({ message: { role: 'assistant' as const, content: 'Hello' }, stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } })),
        structured: vi.fn(async () => { throw new Error('Unused'); }),
        close: vi.fn(async () => {}),
    };
}

it('uses a borrowed application provider with explicit identity and closes only owned tools', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'preset-application-'));
    const provider = applicationProvider();
    const closeTools = vi.fn(async () => {});
    construct.mockClear();
    try {
        const extensions = await defaultAgentExtensions({ workspace, provider });
        const extension = extensions.find(extension => extension.roles?.provider)!;
        expect(extension).toMatchObject({ id: 'provider.application', version: '1.0.0', configuration: 'application-v1' });
        expect(await extension.roles!.provider!()).toBe(provider);
        const overridden = await defaultAgentExtensions({ workspace, provider, providerIdentity: 'deployment-v2' });
        expect(overridden.find(extension => extension.roles?.provider)?.configuration).toBe('deployment-v2');
        expect(compositionFingerprint(overridden)).not.toBe(compositionFingerprint(extensions));
        const agent = await createDefaultAgent({
            workspace, provider,
            additionalToolsIdentity: 'empty-v1',
            additionalTools: () => ({ tools: () => [], validate: (_name, args) => ({ ok: true, args }), call: async () => ({ ok: false, content: 'Unused' }), close: closeTools }),
        });
        try {
            const session = await agent.create();
            await agent.submit(session.id, 'Hello', { commandId: 'hello' });
            expect((await agent.wait(session.id)).status).toBe('idle');
            expect(provider.turn).toHaveBeenCalledOnce();
        } finally { await agent.close(); }
        expect(closeTools).toHaveBeenCalledOnce();
        expect(provider.close).not.toHaveBeenCalled();
        expect(construct).not.toHaveBeenCalled();
    } finally { await rm(workspace, { recursive: true, force: true }); }
});

it('requires unambiguous provider configuration and known context capacity', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'preset-provider-validation-'));
    try {
        const provider = applicationProvider();
        for (const conflict of [{ model: 'other' }, { reasoningEffort: 'low' as const }, { authFilePath: '/unused' }]) {
            await expect(defaultAgentExtensions({ workspace, provider, ...conflict })).rejects.toThrow('cannot be combined');
        }
        await expect(defaultAgentExtensions({ workspace, providerIdentity: 'orphan' })).rejects.toThrow('requires a supplied provider');
        const opaque = { ...provider, configurationIdentity: undefined, capabilities: undefined };
        await expect(defaultAgentExtensions({ workspace, provider: opaque })).rejects.toThrow('nonempty');
        await expect(defaultAgentExtensions({ workspace, provider, providerIdentity: ' ' })).rejects.toThrow('nonempty');
        await expect(defaultAgentExtensions({ workspace, provider: opaque, providerIdentity: 'opaque-v1' })).rejects.toThrow('capacity is unknown');
        const extensions = await defaultAgentExtensions({ workspace, provider: opaque, providerIdentity: 'opaque-v1', tokenBudget: 32000 });
        expect(extensions.find(extension => extension.roles?.provider)?.configuration).toBe('opaque-v1');
    } finally { await rm(workspace, { recursive: true, force: true }); }
});

it('does not import the subscription backend on the supplied-provider path', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'preset-no-subscription-'));
    try {
        const hooks = `export async function resolve(specifier, context, nextResolve) {
            if (specifier.includes('subscription.js') || specifier.startsWith('@openai-oauth/')) throw new Error('Optional backend imported');
            return nextResolve(specifier, context);
        }`;
        const entry = pathToFileURL(join(process.cwd(), 'dist/runtime/harness/preset.js')).href;
        const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
            import { register } from 'node:module';
            register(${JSON.stringify('data:text/javascript,' + encodeURIComponent(hooks))}, import.meta.url);
            const { createDefaultAgent } = await import(${JSON.stringify(entry)});
            const provider = { configurationIdentity: 'isolated-v1', capabilities: { contextWindowTokens: 32000 } };
            const agent = await createDefaultAgent({ workspace: ${JSON.stringify(workspace)}, provider });
            await agent.close();
            console.log('ok');
        `], { encoding: 'utf8', timeout: 10000 });
        expect(output.trim()).toBe('ok');
    } finally { await rm(workspace, { recursive: true, force: true }); }
});
