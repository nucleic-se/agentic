import { expect, it, vi } from 'vitest';
import { AnthropicSubscriptionProvider } from './anthropic-subscription.js';
import { executeModelTurn, executeStructuredModel } from '../runtime/ModelExecutor.js';
import type { ProviderRequestObservation } from '../contracts/llm.js';

const token = 'sk-ant-oat01-test-authorized-token';
const model = 'claude-opus-4-6';
type Block = { type: 'text'; text: string } | { type: 'thinking'; thinking: string; signature: string }
    | { type: 'tool_use'; id: string; name: string; json: string } | { type: 'redacted_thinking'; data: string };
function response(blocks: Block[], stopReason = 'end_turn', partial = false): Response {
    const events: unknown[] = [{ type: 'message_start', message: {
        id: 'msg-fixture', model, role: 'assistant', content: [],
        usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
    } }];
    blocks.forEach((block, index) => {
        const initial = block.type === 'tool_use' ? { type: block.type, id: block.id, name: block.name, input: {} }
            : block.type === 'text' ? { type: block.type, text: '' }
            : block.type === 'thinking' ? { type: block.type, thinking: '', signature: '' } : block;
        events.push({ type: 'content_block_start', index, content_block: initial });
        if (block.type === 'text') events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
        if (block.type === 'thinking') {
            events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } });
            events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } });
        }
        if (block.type === 'tool_use') events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: block.json } });
        events.push({ type: 'content_block_stop', index });
    });
    if (!partial) events.push({ type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 7, output_tokens_details: { thinking_tokens: 2 } } }, { type: 'message_stop' });
    return new Response(events.map(event => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

it('streams native text, observes final OAuth wire shape, and preserves usage', async () => {
    const requests: ProviderRequestObservation[] = [], deltas: string[] = [];
    let headers: Headers | undefined;
    const provider = new AnthropicSubscriptionProvider({ model, credentials: async () => token,
        onRequest: request => { requests.push(request); },
        fetch: async (_url, init) => { headers = new Headers(init?.headers); return response([{ type: 'text', text: 'Hello' }]); },
    });
    const result = await provider.streamTurn({ system: 'Application rules.', messages: [{ role: 'user', content: 'Hi' }], maxTokens: 1000 }, delta => deltas.push(delta));
    expect(result.message.content).toBe('Hello');
    expect(deltas).toEqual(['Hello']);
    expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: 2, totalTokens: 22 });
    expect(requests[0].body).toMatchObject({ model, max_tokens: 1000, system: [
        expect.objectContaining({ text: "You are Claude Code, Anthropic's official CLI for Claude." }),
        expect.objectContaining({ text: 'Application rules.' }),
    ] });
    expect(headers!.get('authorization')).toBe(`Bearer ${token}`);
    expect(headers!.get('user-agent')).toMatch(/^claude-cli\//);
    expect(headers!.get('x-app')).toBe('cli');
    expect(JSON.stringify(requests)).not.toContain(token);
    expect(provider.capabilities).toMatchObject({ outputLimit: 'enforced', automaticRetries: 0, contextWindowTokens: 1000000 });
});

it('replays thinking signatures with native tool results and image blocks', async () => {
    const requests: any[] = [];
    const provider = new AnthropicSubscriptionProvider({ model, credentials: async () => token, thinkingEnabled: true,
        onRequest: request => { requests.push(request.body); },
        fetch: async () => response([
            { type: 'thinking', thinking: 'Check the file.', signature: 'signed-thinking' },
            { type: 'redacted_thinking', data: 'opaque-redaction' },
            { type: 'text', text: 'Inspecting.' },
            { type: 'tool_use', id: 'call_read', name: 'read_file', json: '{"path":"file.txt"}' },
        ], 'tool_use'),
    });
    const tools = [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' as const } }];
    const first = await provider.turn({ messages: [{ role: 'user', content: 'Inspect' }], tools });
    expect(first.message.toolCalls).toEqual([{ id: 'call_read', name: 'read_file', args: { path: 'file.txt' } }]);
    const annotations = JSON.stringify(first.message.continuation!.data);
    expect(annotations).toContain('signed-thinking');
    expect(annotations).not.toContain('Inspecting.');
    expect(annotations).not.toContain('file.txt');
    await provider.turn({ messages: [{ role: 'user', content: 'Inspect' }, JSON.parse(JSON.stringify(first.message)), {
        role: 'tool_result', toolCallId: 'call_read', content: 'File contents',
        contentBlocks: [{ type: 'text', text: 'File contents' }, { type: 'image', mimeType: 'image/png', data: 'AQID' }],
    }], tools });
    const assistant = requests[1].messages.find((message: any) => message.role === 'assistant');
    expect(assistant.content).toContainEqual({ type: 'thinking', thinking: 'Check the file.', signature: 'signed-thinking' });
    expect(assistant.content).toContainEqual({ type: 'redacted_thinking', data: 'opaque-redaction' });
    expect(JSON.stringify(requests[1].messages)).toContain('image/png');
    expect(JSON.stringify(requests[1].messages)).toContain('File contents');
});

it('uses one forced schema tool for structured output and rejects truncation', async () => {
    let stop = 'tool_use';
    const requests: any[] = [];
    const provider = new AnthropicSubscriptionProvider({ model, credentials: async () => token,
        onRequest: request => { requests.push(request.body); },
        fetch: async () => response([{ type: 'tool_use', id: 'schema', name: 'structured_output', json: '{"answer":42}' }], stop),
    });
    const request = { messages: [{ role: 'user' as const, content: 'Answer' }], schema: { type: 'object' as const, properties: { answer: { type: 'integer' as const } }, required: ['answer'] }, maxTokens: 1000 };
    expect((await executeStructuredModel(provider, request)).value).toEqual({ answer: 42 });
    expect(requests[0]).toMatchObject({ tool_choice: { type: 'any' }, tools: [expect.objectContaining({ name: 'structured_output', input_schema: request.schema })] });
    stop = 'max_tokens';
    await expect(provider.structured(request)).rejects.toMatchObject({ name: 'LLMProtocolError', usage: expect.objectContaining({ outputTokens: 7 }) });
});

it('rejects invalid continuation and unsupported options before credential access', async () => {
    const credentials = vi.fn(async () => token);
    const provider = new AnthropicSubscriptionProvider({ model, credentials, fetch: async () => response([{ type: 'text', text: 'Hello' }]) });
    const first = await provider.turn({ messages: [] });
    first.message.continuation!.data = { content: [{ type: 'text', length: -1 }] };
    await expect(provider.turn({ messages: [first.message] })).rejects.toThrow('continuation');
    await expect(provider.turn({ messages: [], previousResponseId: 'opaque' })).rejects.toThrow('explicit message replay');
    await expect(provider.turn({ messages: [], stopSequences: ['stop'] })).rejects.toThrow('unsupported');
    await expect(provider.turn({ messages: [] }, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(credentials).toHaveBeenCalledOnce();
});

it('does not retry transport errors or report unknown usage as zero', async () => {
    const fetch = vi.fn(async () => new Response('Unavailable', { status: 503 }));
    const provider = new AnthropicSubscriptionProvider({ model, credentials: async () => token, fetch });
    let outcome: unknown;
    await expect(executeModelTurn(provider, { messages: [] }, { onOutcome: value => { outcome = value; } })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({ outcome: 'failed', dispatched: true, failure: { kind: 'transport' } });
    expect(outcome).not.toHaveProperty('usage');
});

it('preserves measured usage when a stream ends before completion', async () => {
    const provider = new AnthropicSubscriptionProvider({ model, credentials: async () => token, fetch: async () => response([{ type: 'text', text: 'Partial' }], 'end_turn', true) });
    await expect(provider.turn({ messages: [] })).rejects.toMatchObject({ name: 'LLMProtocolError', usage: expect.objectContaining({ inputTokens: 15 }) });
});

it('isolates observations and stops HTTP dispatch when request journaling fails', async () => {
    const fetch = vi.fn(async () => response([{ type: 'text', text: 'Hello' }]));
    const provider = new AnthropicSubscriptionProvider({ model, credentials: async () => token, fetch,
        onRequest: request => { request.body = { changed: true }; },
    });
    await expect(provider.turn({ messages: [] }, { onRequest: request => {
        expect(request.body).toHaveProperty('model', model);
        throw new Error('Journal unavailable');
    } })).rejects.toThrow('Journal unavailable');
    expect(fetch).not.toHaveBeenCalled();
});

it('rejects duplicate tool identities and retains backend JSON-normalization behavior', async () => {
    let duplicate = true;
    const provider = new AnthropicSubscriptionProvider({ model, credentials: async () => token, fetch: async () => response([
        { type: 'tool_use', id: 'same', name: 'read_file', json: '{"path":"file"' },
        ...(duplicate ? [{ type: 'tool_use' as const, id: 'same', name: 'read_file', json: '{}' }] : []),
    ], 'tool_use') });
    await expect(provider.turn({ messages: [] })).rejects.toThrow('Duplicate tool call IDs');
    duplicate = false;
    // Pi repairs partial JSON. The host must still validate and authorize the normalized arguments.
    expect((await provider.turn({ messages: [] })).message.toolCalls?.[0].args).toEqual({ path: 'file' });
});

it('cancels an in-flight transport', async () => {
    let observedSignal: AbortSignal | null | undefined;
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const provider = new AnthropicSubscriptionProvider({ model, credentials: async () => token,
        fetch: async (_url, init) => {
            observedSignal = init?.signal;
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'partial', model, usage: { input_tokens: 5, output_tokens: 0 } } })}\n\n`));
                    ready();
                },
            });
            return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
        },
    });
    const controller = new AbortController();
    const pending = provider.turn({ messages: [] }, { signal: controller.signal });
    await started;
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(observedSignal?.aborted).toBe(true);
});

it('retains managed thinking level for replay and rejects incompatible structured settings', async () => {
    const credentials = vi.fn(async () => token);
    const provider = new AnthropicSubscriptionProvider({ model: 'claude-opus-5', credentials, effort: 'medium',
        fetch: async () => response([{ type: 'thinking', thinking: '', signature: 'managed-signature' }, { type: 'text', text: 'Done' }]),
    });
    const first = await provider.turn({ messages: [] });
    expect(first.message.continuation?.data).toMatchObject({ providerThinkingLevel: 'medium' });
    await expect(provider.structured({ messages: [], schema: { type: 'object' } })).rejects.toThrow('unsupported with enabled thinking');
    expect(credentials).toHaveBeenCalledOnce();
    expect(() => new AnthropicSubscriptionProvider({ model, credentials, effort: 'high' })).toThrow('require enabled thinking');
});
