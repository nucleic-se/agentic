import { expect, it, vi } from 'vitest';
import { SubscriptionProvider } from './subscription.js';
import { executeToolBatch } from '../runtime/ToolBatchExecutor.js';
import { executeModelTurn } from '../runtime/ModelExecutor.js';
import type { IValidatedToolRuntime } from '../contracts/tool-runtime.js';

const token = `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64')}.x`;
function response(reasoning: number | undefined, thinking?: { text: string; signature?: string }): Response {
    const item = { type: 'message', id: 'msg_test', role: 'assistant', content: [{ type: 'output_text', text: 'OK', annotations: [] }] };
    const thought = thinking && { type: 'reasoning', id: 'rs_test', summary: [{ type: 'summary_text', text: thinking.text }],
        ...(thinking.signature === undefined ? {} : { encrypted_content: thinking.signature }) };
    const events = [
        ...(thought ? [
            { type: 'response.output_item.added', output_index: 1, item: { ...thought, summary: [] } },
            { type: 'response.reasoning_summary_text.delta', output_index: 1, delta: thinking!.text },
            { type: 'response.output_item.done', output_index: 1, item: thought },
        ] : []),
        { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
        { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'OK' },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'resp_test', status: 'completed', output: [item], usage: {
            input_tokens: 40, output_tokens: 7, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 5 },
            output_tokens_details: { reasoning_tokens: reasoning }, total_tokens: 47,
        } } },
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

it('observes the real normalized request and preserves usage and text signatures', async () => {
    const requests: unknown[] = [], deltas: string[] = [];
    const provider = new SubscriptionProvider({ model: 'fixture', credentials: async () => token,
        fetch: async () => response(3), onRequest: request => { requests.push(request.body); } });
    const result = await provider.streamTurn({ messages: [{ role: 'user', content: 'hello' }], maxTokens: 1 }, delta => deltas.push(delta));
    expect(result.message.content).toBe('OK');
    expect(result.message.continuation?.estimatedInputTokens).toBe(3);
    expect(deltas).toEqual(['OK']);
    expect(result.usage).toMatchObject({ inputTokens: 40, outputTokens: 7, cacheReadTokens: 20, cacheWriteTokens: 5, reasoningTokens: 3 });
    expect(requests[0]).toMatchObject({ parallel_tool_calls: true });
    expect(requests[0]).not.toHaveProperty('max_output_tokens');
    expect(provider.capabilities.outputLimit).toBe('advisory');
    const saved = JSON.parse(JSON.stringify(result.message));
    await provider.turn({ messages: [{ role: 'user', content: 'hello' }, saved] });
    expect(JSON.stringify(requests[1])).toContain('msg_test');
    expect(JSON.stringify(saved.continuation.data)).not.toContain('OK');
});

it('rejects malformed continuation before credentials or dispatch', async () => {
    let credentials = 0;
    const provider = new SubscriptionProvider({ model: 'fixture', credentials: async () => { credentials++; return token; }, fetch: async () => response(3) });
    const result = await provider.turn({ messages: [] });
    result.message.continuation!.data = [{ type: 'text', length: -1 }];
    await expect(provider.turn({ messages: [result.message] })).rejects.toThrow('Invalid subscription continuation');
    expect(credentials).toBe(1);
});

it('does not retry transport errors or misreport them as completion', async () => {
    let calls = 0;
    const provider = new SubscriptionProvider({ model: 'fixture', credentials: async () => token, fetch: async () => { calls++; return new Response('Unavailable', { status: 503 }); } });
    let outcome: unknown;
    await expect(executeModelTurn(provider, { messages: [] }, { onOutcome: value => { outcome = value; } })).rejects.toMatchObject({ name: 'Error' });
    expect(calls).toBe(1);
    expect(outcome).toMatchObject({ dispatched: true, outcome: 'failed', failure: { kind: 'transport' } });
    expect(outcome).not.toHaveProperty('usage');
});

it('pre-cancellation prevents credential access', async () => {
    let called = false;
    const provider = new SubscriptionProvider({ model: 'fixture', credentials: async () => { called = true; return token; } });
    await expect(provider.turn({ messages: [] }, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(called).toBe(false);
});

it('isolates request observers and prevents HTTP dispatch if persistence fails', async () => {
    const fetch = vi.fn(async () => response(3));
    const provider = new SubscriptionProvider({ model: 'fixture', credentials: async () => token, fetch,
        onRequest: observed => { observed.body = { replaced: true }; } });
    await expect(provider.turn({ messages: [] }, { onRequest: observed => {
        expect(observed.body).toHaveProperty('model', 'fixture');
        throw new Error('Request journal unavailable');
    } })).rejects.toThrow('Request journal unavailable');
    expect(fetch).not.toHaveBeenCalled();
});

it('records the dependency boundary for malformed final tool arguments', async () => {
    const item = { type: 'function_call', id: 'fc_test', call_id: 'call_test', name: 'write', arguments: '{"path":"file"' };
    const events = [
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'resp_test', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1 } } },
    ];
    const provider = new SubscriptionProvider({ model: 'fixture', credentials: async () => token, fetch: async () => new Response(
        events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }),
    });
    // The backend normalizes imperfect JSON. Execution still validates and
    // authorizes the resulting arguments through the shared boundary.
    const result = await provider.turn({ messages: [], tools: [{ name: 'write', description: 'Write a file', parameters: { type: 'object' } }] });
    expect(result.stopReason).toBe('tool_use');
    expect(result.message.toolCalls?.[0].args).toEqual({ path: 'file' });
});

it.each([
    ['{"path":"workspace/file"', true, true],
    ['{"path":"outside/file"', true, false],
    ['{"path":', false, false],
    ['{"path":42', false, false],
] as const)('validates and authorizes normalized tool input %s', async (argumentsText, valid, allowed) => {
    const item = { type: 'function_call', id: 'fc_test', call_id: 'call_test', name: 'write', arguments: argumentsText };
    const events = [
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1 } } },
    ];
    const provider = new SubscriptionProvider({ model: 'fixture', credentials: async () => token, fetch: async () => new Response(
        events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }) });
    const response = await provider.turn({ messages: [] });
    const call = vi.fn(async () => ({ ok: true, content: 'Recorded' }));
    const tools: IValidatedToolRuntime = { tools: () => [], call,
        validate: (_name, args) => typeof args.path === 'string' ? { ok: true, args: { path: args.path } }
            : { ok: false, result: { ok: false, content: 'Expected path', errorKind: 'validation' } } };
    const evaluated: unknown[] = [], approved: unknown[] = [];
    const result = await executeToolBatch(response.message.toolCalls!, { tools,
        policy: { evaluate: async ({ args }) => { evaluated.push(structuredClone(args));
            return String(args.path).startsWith('workspace/') ? { kind: 'confirm', reason: 'Write approval' } : { kind: 'deny', reason: 'Outside workspace' }; } },
        confirmToolCall: ({ args }) => { approved.push(structuredClone(args)); args.path = 'outside/tampered'; return true; },
    });
    expect(evaluated.length).toBe(valid ? 1 : 0);
    expect(approved.length).toBe(allowed ? 1 : 0);
    expect(call).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(result[0].dispatched).toBe(allowed);
    if (allowed) {
        expect(call.mock.calls[0]).toEqual(['write', { path: 'workspace/file' }, expect.objectContaining({ authorizedArgs: { path: 'workspace/file' } })]);
        expect(approved).toEqual([{ path: 'workspace/file' }]);
    }
});

it('passes cancellation to the dependency HTTP request', async () => {
    const controller = new AbortController();
    const provider = new SubscriptionProvider({ model: 'fixture', credentials: async () => token,
        fetch: async (_url, init) => new Promise((_resolve, reject) => {
            init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
            controller.abort();
        }) });
    await expect(provider.turn({ messages: [] }, { signal: controller.signal })).rejects.toThrow();
});

it('preserves failure status in the decoded request without changing receipt text or schemas', async () => {
    const requests: unknown[] = [];
    const provider = new SubscriptionProvider({ model: 'fixture', credentials: async () => token,
        fetch: async () => response(3), onRequest: request => { requests.push(request.body); } });
    const tool = { name: 'read', description: 'Read exact evidence', parameters: { type: 'object' as const, properties: { limit: { type: 'integer' as const, maximum: 100 } } } };
    const result = { role: 'tool_result' as const, toolCallId: 'call', toolName: 'read', content: 'same evidence' };
    for (const isError of [false, true]) await provider.turn({ system: 'root instructions', tools: [tool], messages: [
        { role: 'user', content: 'human correction' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call', name: 'read', args: {} }] }, { ...result, isError },
    ] });
    expect(JSON.stringify(requests[0])).not.toContain('[Tool failed]');
    expect(JSON.stringify(requests[1])).toContain('[Tool failed]');
    expect(JSON.stringify(requests[1])).toContain('same evidence');
    expect(requests[1]).toMatchObject({ instructions: 'root instructions', tools: [expect.objectContaining(tool)] });
    expect(result.content).toBe('same evidence');
});


it.each([
    { reasoning: 8, text: '', signature: 'opaque', expected: 8 },
    { reasoning: 3, text: 'x'.repeat(80), signature: 'opaque', expected: 20 },
    { reasoning: 0, text: '', signature: 'opaque', expected: undefined },
    { reasoning: undefined, text: '', signature: 'opaque', expected: undefined },
])('estimates reasoning without measuring encrypted length: $expected', async ({ reasoning, text, signature, expected }) => {
    const requests: unknown[] = [];
    const provider = new SubscriptionProvider({ model: 'fixture', credentials: async () => token,
        fetch: async () => response(reasoning, { text, signature }), onRequest: request => { requests.push(request.body); } });
    const result = await provider.turn({ messages: [] });
    expect(result.message.continuation?.estimatedInputTokens).toBe(expected);
    await provider.turn({ messages: [result.message] });
    const restored = structuredClone(result.message);
    delete restored.continuation!.estimatedInputTokens;
    await provider.turn({ messages: [restored] });
    expect(requests[1]).toEqual(requests[2]);
    expect(JSON.stringify(requests[1])).toContain(signature);
});
