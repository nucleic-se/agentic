import { zstdDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertProviderConformance, assertSessionStoreConformance } from './index.js';
import type { ProviderScenarioFactory } from './provider.js';
import { MemorySessionStore, createSqliteSessionStore } from '../harness/stores.js';
import { OpenAICompatibleProvider } from '../../providers/openai-compatible.js';
import { AnthropicProvider } from '../../providers/anthropic.js';
import { SubscriptionProvider } from '../../providers/subscription.js';
const subscriptionToken = `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64')}.x`;

type Kind = 'openai' | 'anthropic' | 'codex';
function factory(kind: Kind): ProviderScenarioFactory {
    return scenario => {
        const calls: Array<{ maxTokens?: number; signal?: AbortSignal | null }> = [];
        let start!: () => void, cancel: ((reason: Error) => void) | undefined;
        const started = new Promise<void>(resolve => { start = resolve; });
        const previousFetch = globalThis.fetch;
        const transport = async (_url: unknown, init?: RequestInit): Promise<Response> => {
            const raw = new Headers(init?.headers).get('content-encoding') === 'zstd' ? zstdDecompressSync(Buffer.from(init!.body as Uint8Array)).toString() : String(init?.body);
            const body = JSON.parse(raw);
            calls.push({ maxTokens: body.max_tokens ?? body.max_output_tokens, signal: init?.signal });
            start();
            if (scenario === 'blocked') {
                init?.signal?.throwIfAborted();
                return new Promise<Response>((_resolve, reject) => {
                    cancel = reject;
                    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
                });
            }
            const text = scenario === 'turn' ? 'ok' : '{"answer":"ok"}';
            const truncated = scenario === 'truncated';
            if (kind === 'openai') return Response.json({
                choices: [{ finish_reason: truncated ? 'length' : 'stop', message: { role: 'assistant', content: text } }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
            });
            if (kind === 'anthropic') return Response.json({
                content: scenario === 'turn' ? [{ type: 'text', text }] : [{ type: 'tool_use', id: 'result', name: 'structured_output', input: { answer: 'ok' } }],
                stop_reason: truncated ? 'max_tokens' : scenario === 'turn' ? 'end_turn' : 'tool_use',
                usage: { input_tokens: 1, output_tokens: 1 },
            });
            const item = scenario === 'turn' ? { type: 'message', id: 'msg_test', role: 'assistant', content: [{ type: 'output_text', text }] } : { type: 'function_call', id: 'fc_test', call_id: 'call_test', name: 'structured_output', arguments: text };
            const events = [
                { type: 'response.output_item.added', output_index: 0, item },
                { type: 'response.output_item.done', output_index: 0, item },
                { type: 'response.completed', response: { id: 'response', status: truncated ? 'incomplete' : 'completed',
                    ...(truncated ? { incomplete_details: { reason: 'max_output_tokens' } } : {}), usage: { input_tokens: 1, output_tokens: 1 } } },
            ];
            return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
        };
        if (kind !== 'codex') globalThis.fetch = transport;
        const provider = kind === 'openai' ? new OpenAICompatibleProvider({ model: 'test', baseUrl: 'https://conformance.invalid' })
            : kind === 'anthropic' ? new AnthropicProvider({ model: 'test', apiKey: 'fake', baseUrl: `https://conformance.invalid/${scenario}`, minRequestSpacingMs: 0 })
            : new SubscriptionProvider({ model: 'test', credentials: async () => subscriptionToken, fetch: transport });
        return { provider, calls, started, dispose() { globalThis.fetch = previousFetch; cancel?.(new Error('fixture disposed')); } };
    };
}

describe('framework-neutral adapter conformance', () => {
    for (const kind of ['openai', 'anthropic', 'codex'] as const) {
        it(`checks the actual ${kind} adapter with a deterministic transport`, async () => {
            expect((await assertProviderConformance(factory(kind))).checks).toHaveLength(7);
        });
    }
    it('checks MemorySessionStore', async () => {
        expect((await assertSessionStoreConformance(() => ({ store: new MemorySessionStore() }))).checks).toHaveLength(5);
    });
    it('checks SQLite including reopen durability', async () => {
        const path = await mkdtemp(join(tmpdir(), 'agentic-conformance-'));
        const open = () => createSqliteSessionStore(join(path, 'sessions.sqlite'));
        const report = await assertSessionStoreConformance(async () => ({ store: await open(), reopen: open, dispose: () => rm(path, { recursive: true, force: true }) }));
        expect(report.checks).toHaveLength(6);
    });
    it('rejects an adapter that drops the structured output limit', async () => {
        const correct = factory('openai');
        await expect(assertProviderConformance(async scenario => {
            const fixture = await correct(scenario);
            if (scenario === 'structured') {
                const original = fixture.provider.structured.bind(fixture.provider);
                fixture.provider.structured = (request, options) => original({ ...request, maxTokens: undefined }, options);
            }
            return fixture;
        })).rejects.toThrow(/Structured output limit/);
    });
    it('rejects a store that returns mutable internal state', async () => {
        const store = new MemorySessionStore();
        let shared: Awaited<ReturnType<typeof store.get>>;
        const get = store.get.bind(store);
        store.get = async id => shared ??= await get(id);
        await expect(assertSessionStoreConformance(() => ({ store }))).rejects.toThrow();
    });
});
