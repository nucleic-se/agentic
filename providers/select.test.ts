import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { selectProvider, type ProviderSelection } from './select.js';

const optional = vi.hoisted(() => ({ openaiImports: 0, anthropicImports: 0, options: [] as unknown[] }));
vi.mock('./subscription.js', () => {
    optional.openaiImports++;
    return { SubscriptionProvider: class { constructor(options: unknown) { optional.options.push(options); } } };
});
vi.mock('./anthropic-subscription.js', () => {
    optional.anthropicImports++;
    return { AnthropicSubscriptionProvider: class { constructor(options: unknown) { optional.options.push(options); } } };
});
beforeEach(() => {
    vi.resetModules();
    optional.openaiImports = 0;
    optional.anthropicImports = 0;
    optional.options.length = 0;
    for (const name of ['AGENTIC_OPENAI_API_KEY', 'OPENAI_API_KEY', 'AGENTIC_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY', 'AGENTIC_OPENAI_BASE_URL']) {
        vi.stubEnv(name, undefined);
    }
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it.each(['openai', 'anthropic'] as const)('selects %s API auth without loading subscription backends', async provider => {
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(provider === 'openai'
        ? { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
        : { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const selected = await selectProvider({ provider, auth: 'api-key', model: 'fixture', apiKey: 'explicit-key' });
    const result = await selected.turn({ messages: [{ role: 'user', content: 'hello' }] });
    expect(result.message.content).toBe('done');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(provider === 'openai' ? 'https://api.openai.com/v1/chat/completions' : 'https://api.anthropic.com/v1/messages');
    const headers = new Headers(init.headers);
    expect(headers.get(provider === 'openai' ? 'authorization' : 'x-api-key')).toBe(provider === 'openai' ? 'Bearer explicit-key' : 'explicit-key');
    expect(optional.openaiImports + optional.anthropicImports).toBe(0);
});

it.each(['openai', 'anthropic'] as const)('resolves %s keys with explicit then Agentic then conventional precedence', async provider => {
    const prefix = provider.toUpperCase();
    vi.stubEnv(`${prefix}_API_KEY`, 'conventional');
    vi.stubEnv(`AGENTIC_${prefix}_API_KEY`, 'agentic');
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(provider === 'openai'
        ? { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
        : { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    for (const [apiKey, expected] of [['explicit', 'explicit'], [undefined, 'agentic'], [undefined, 'conventional']] as const) {
        if (expected === 'conventional') vi.stubEnv(`AGENTIC_${prefix}_API_KEY`, undefined);
        const selected = await selectProvider({ provider, auth: 'api-key', model: 'fixture', apiKey });
        await selected.turn({ messages: [{ role: 'user', content: 'hello' }] });
        const init = fetch.mock.lastCall?.[1] as RequestInit | undefined;
        const headers = new Headers(init?.headers);
        expect(headers.get(provider === 'openai' ? 'authorization' : 'x-api-key')).toBe(provider === 'openai' ? `Bearer ${expected}` : expected);
    }
});

it.each(['openai', 'anthropic'] as const)('rejects missing and explicitly blank %s API keys', async provider => {
    await expect(selectProvider({ provider, auth: 'api-key', model: 'fixture' })).rejects.toThrow('requires an API key');
    vi.stubEnv(`${provider.toUpperCase()}_API_KEY`, 'fallback');
    for (const apiKey of ['', '   ']) {
        await expect(selectProvider({ provider, auth: 'api-key', model: 'fixture', apiKey })).rejects.toThrow('requires an API key');
    }
});

it.each(['openai', 'anthropic'] as const)('loads only the selected %s subscription backend and forwards its credentials source', async provider => {
    const credentials = vi.fn(async () => 'token');
    const selection = { provider, auth: 'subscription' as const, model: 'fixture', credentials };
    await selectProvider(selection);
    expect(optional.openaiImports).toBe(provider === 'openai' ? 1 : 0);
    expect(optional.anthropicImports).toBe(provider === 'anthropic' ? 1 : 0);
    expect(optional.options).toEqual([selection]);
    expect(credentials).not.toHaveBeenCalled();
});

it('rejects invalid selections before loading a backend', async () => {
    for (const selection of [
        { provider: 'openai', auth: 'api-key', model: '' },
        { provider: 'other', auth: 'api-key', model: 'fixture' },
        { provider: 'openai', auth: 'other', model: 'fixture' },
    ]) await expect(selectProvider(selection as ProviderSelection)).rejects.toThrow();
    expect(optional.openaiImports + optional.anthropicImports).toBe(0);
});

it('constructs both API providers when optional backend imports are forbidden', () => {
    const hooks = `export async function resolve(specifier, context, nextResolve) {
        if (specifier.includes('subscription.js') || specifier.startsWith('@earendil-works/pi-ai') || specifier.startsWith('@openai-oauth/')) {
            throw new Error('Optional backend imported: ' + specifier);
        }
        return nextResolve(specifier, context);
    }`;
    const entry = pathToFileURL(join(process.cwd(), 'dist/providers/select.js')).href;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { register } from 'node:module';
        register(${JSON.stringify('data:text/javascript,' + encodeURIComponent(hooks))}, import.meta.url);
        const { selectProvider } = await import(${JSON.stringify(entry)});
        for (const provider of ['openai', 'anthropic']) {
            const selected = await selectProvider({ provider, auth: 'api-key', model: 'fixture', apiKey: 'fixture' });
            if (typeof selected.turn !== 'function') throw new Error('Missing provider');
        }
        console.log('ok');
    `], { encoding: 'utf8', timeout: 10000 });
    expect(output.trim()).toBe('ok');
});

it('preserves the Agentic OpenAI endpoint override below an explicit URL', async () => {
    vi.stubEnv('AGENTIC_OPENAI_BASE_URL', 'https://environment.invalid/v1');
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    for (const baseUrl of [undefined, 'https://explicit.invalid/v1']) {
        const selected = await selectProvider({ provider: 'openai', auth: 'api-key', model: 'fixture', apiKey: 'fixture', baseUrl });
        await selected.turn({ messages: [{ role: 'user', content: 'hello' }] });
        expect(fetch.mock.lastCall?.[0]).toBe(`${baseUrl ?? 'https://environment.invalid/v1'}/chat/completions`);
    }
});

it.each(['openai', 'anthropic'] as const)('gives %s API providers stable credential-free identities', async provider => {
    const config = { provider, auth: 'api-key' as const, model: 'fixture', apiKey: 'first-secret' };
    const first = await selectProvider(config);
    const rotated = await selectProvider({ ...config, apiKey: 'rotated-secret' });
    expect(first.configurationIdentity).toMatch(/^agentic-api-v1:[a-f0-9]{64}$/);
    expect(rotated.configurationIdentity).toBe(first.configurationIdentity);
    expect((await selectProvider({ ...config, model: 'other' })).configurationIdentity).not.toBe(first.configurationIdentity);
    expect((await selectProvider({ ...config, baseUrl: 'https://other.invalid' })).configurationIdentity).not.toBe(first.configurationIdentity);
    const explicitDefaults = provider === 'openai'
        ? { ...config, provider: 'openai' as const, embeddingModel: 'fixture', providerName: 'OpenAICompatibleProvider',
            recoverTextToolCalls: false, previousResponseContinuation: false,
            retry: { retryableStatuses: new Set([529, 503, 502, 429]), maxRetries: 6, baseDelayMs: 2000, maxDelayMs: 60000, resetHeaders: [] } }
        : { ...config, provider: 'anthropic' as const, maxTokens: 4096, minRequestSpacingMs: 1000 };
    expect((await selectProvider(explicitDefaults)).configurationIdentity).toBe(first.configurationIdentity);
    const changed = provider === 'openai'
        ? { ...config, provider: 'openai' as const, retry: { maxRetries: 0 } }
        : { ...config, provider: 'anthropic' as const, maxTokens: 100 };
    expect((await selectProvider(changed)).configurationIdentity).not.toBe(first.configurationIdentity);
});

it('requires caller identity for opaque overrides and never hashes their secrets', async () => {
    const overrides: ProviderSelection[] = [
        { provider: 'openai', auth: 'api-key', model: 'fixture', apiKey: 'key', headers: { authorization: 'secret' } },
        { provider: 'openai', auth: 'api-key', model: 'fixture', apiKey: 'key', extraBody: { secret: 'value' } },
        { provider: 'openai', auth: 'api-key', model: 'fixture', apiKey: 'key', retry: { onRetry: () => {} } },
        { provider: 'anthropic', auth: 'api-key', model: 'fixture', apiKey: 'key', onRetry: () => {} },
    ];
    for (const config of overrides) {
        await expect(selectProvider(config)).rejects.toThrow('explicit providerIdentity');
        const selected = await selectProvider({ ...config, providerIdentity: 'application-gateway-v1' } as ProviderSelection);
        expect(selected.configurationIdentity).toBe('application-gateway-v1');
    }
    await expect(selectProvider({ provider: 'openai', auth: 'api-key', model: 'fixture', apiKey: 'key', providerIdentity: '' })).rejects.toThrow('providerIdentity must be nonempty');
});

it.each(['openai', 'anthropic'] as const)('plugs the selected %s API provider directly into the native preset', async provider => {
    const workspace = await mkdtemp(join(tmpdir(), 'selected-provider-'));
    try {
        const selected = await selectProvider({ provider, auth: 'api-key', model: 'fixture', apiKey: 'fixture' });
        const { createDefaultAgent } = await import('../runtime/harness/preset.js');
        const agent = await createDefaultAgent({ workspace, provider: selected, tokenBudget: 16000 });
        try {
            const session = await agent.create();
            expect(session.id).toBeTruthy();
        } finally { await agent.close(); }
        expect(optional.openaiImports + optional.anthropicImports).toBe(0);
    } finally { await rm(workspace, { recursive: true, force: true }); }
});
