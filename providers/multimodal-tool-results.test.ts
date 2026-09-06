import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../contracts/llm.js';
import { CodexSubscriptionProvider } from './codex-subscription.js';
import { AnthropicProvider } from './anthropic.js';
import { toOpenAIMessages } from './openai-compatible.js';

afterEach(() => vi.unstubAllGlobals());
const history: Message[] = [
    { role: 'user', content: 'Inspect image' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'image-call', name: 'image', args: {} }, { id: 'other-call', name: 'other', args: {} }] },
    { role: 'tool_result', toolCallId: 'image-call', toolName: 'image', content: 'fallback', contentBlocks: [{ type: 'text', text: 'rich text' }, { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }] },
    { role: 'tool_result', toolCallId: 'other-call', content: 'second result' },
];
describe('multimodal tool output translation', () => {
    it('sends native image/text function outputs through the Codex Responses transport', async () => {
        const request = vi.fn(async () => new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'seen' }] }], usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`));
        const provider = new CodexSubscriptionProvider({ model: 'test', transport: { request } });
        await provider.turn({ messages: history });
        const init = (request.mock.calls[0] as unknown as [string, RequestInit])[1];
        const body = JSON.parse(String(init.body));
        expect(body.input.find((item: { call_id?: string; type: string }) => item.type === 'function_call_output' && item.call_id === 'image-call').output).toEqual([
            { type: 'input_text', text: 'rich text' },
            { type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=', detail: 'auto' },
        ]);
    });
    it('preserves native image blocks inside Anthropic tool results', async () => {
        const fetch = vi.fn(async () => new Response(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'seen' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } }));
        vi.stubGlobal('fetch', fetch);
        await new AnthropicProvider({ apiKey: 'test', model: 'test', minRequestSpacingMs: 0 }).turn({ messages: history });
        const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
        const body = JSON.parse(String(init.body));
        expect(body.messages.at(-1).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'image-call', content: [
            { type: 'text', text: 'rich text' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } },
        ] });
    });
    it('finishes Chat Completions tool-result batches before adding user image content', () => {
        const messages = toOpenAIMessages(undefined, [...history, { role: 'user', content: 'Follow-up' }]);
        expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user', 'user']);
        expect(messages[2]?.content).toBe('rich text');
        expect(messages[4]?.content).toEqual([{ type: 'text', text: 'Image returned by tool image:' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } }]);
        expect(messages[5]?.content).toBe('Follow-up');
    });
});
