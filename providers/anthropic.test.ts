import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from './anthropic.js';

function provider(): AnthropicProvider {
    return new AnthropicProvider({
        apiKey: 'test-key',
        model: 'test-model',
        baseUrl: `https://anthropic.test/${Math.random()}`,
        minRequestSpacingMs: 0,
    });
}

function anthropicResponse(content: unknown[], stopReason = 'end_turn'): Response {
    return new Response(JSON.stringify({
        content,
        stop_reason: stopReason,
        usage: { input_tokens: 3, output_tokens: 2 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function sseResponse(events: unknown[]): Response {
    const encoded = new TextEncoder().encode(
        events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
    );
    return new Response(new ReadableStream({
        start(controller) {
            controller.enqueue(encoded);
            controller.close();
        },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('AnthropicProvider', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('maps native tool calls and sends the caller signal', async () => {
        const fetchMock = vi.fn().mockResolvedValue(anthropicResponse([
            { type: 'text', text: 'checking' },
            { type: 'tool_use', id: 'call-1', name: 'lookup', input: { id: 7 } },
        ], 'tool_use'));
        vi.stubGlobal('fetch', fetchMock);
        const controller = new AbortController();

        const result = await provider().turn({
            messages: [{ role: 'user', content: 'look up 7' }],
            tools: [{ name: 'lookup', description: 'Lookup', parameters: { type: 'object' } }],
        }, { signal: controller.signal });

        expect(result).toMatchObject({
            stopReason: 'tool_use',
            message: { content: 'checking', toolCalls: [
                { id: 'call-1', name: 'lookup', args: { id: 7 } },
            ] },
        });
        expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal).toBe(controller.signal);
    });

    it('cancels an in-flight request', async () => {
        const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        }));
        vi.stubGlobal('fetch', fetchMock);
        const controller = new AbortController();
        const pending = provider().turn(
            { messages: [{ role: 'user', content: 'wait' }] },
            { signal: controller.signal },
        );

        controller.abort(new Error('anthropic cancelled'));

        await expect(pending).rejects.toThrow('anthropic cancelled');
    });

    it('rejects malformed streamed tool arguments as a protocol error', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
            { type: 'message_start', message: { usage: { input_tokens: 1 } } },
            { type: 'content_block_start', index: 0,
                content_block: { type: 'tool_use', id: 'bad-1', name: 'lookup' } },
            { type: 'content_block_delta', index: 0,
                delta: { type: 'input_json_delta', partial_json: '{bad json' } },
            { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null },
                usage: { output_tokens: 1 } },
            { type: 'message_stop' },
        ])));

        await expect(provider().streamTurn(
            { messages: [{ role: 'user', content: 'lookup' }] },
            () => {},
        )).rejects.toThrow("protocol error: malformed arguments for tool 'lookup'");
    });
});
