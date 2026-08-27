import { describe, expect, it, vi } from 'vitest'

import { LLMProtocolError } from '../contracts/llm.js'
import {
    CodexSubscriptionProvider,
    type CodexSubscriptionTransport,
} from './codex-subscription.js'

function sse(...events: Record<string, unknown>[]): Response {
    return new Response(events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
    })
}

function completed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        type: 'response.completed',
        response: {
            id: 'resp-next',
            status: 'completed',
            usage: {
                input_tokens: 12,
                output_tokens: 4,
                input_tokens_details: { cached_tokens: 8, cache_write_tokens: 2 },
            },
            ...overrides,
        },
    }
}

describe('CodexSubscriptionProvider', () => {
    it('streams text, maps native tool calls, and forwards Responses continuation', async () => {
        const request = vi.fn().mockResolvedValue(sse(
            { type: 'response.output_text.delta', delta: 'Checking ' },
            { type: 'response.output_text.delta', delta: 'now.' },
            {
                type: 'response.output_item.done',
                item: {
                    type: 'function_call', call_id: 'call-1', name: 'search',
                    arguments: '{"query":"calendar"}',
                },
            },
            completed(),
        ))
        const provider = new CodexSubscriptionProvider({
            model: 'gpt-test',
            transport: { request },
            reasoningEffort: 'medium',
        })
        const deltas: string[] = []
        const result = await provider.streamTurn({
            system: 'Use tools.',
            previousResponseId: 'resp-previous',
            messages: [
                { role: 'user', content: 'old question' },
                {
                    role: 'assistant', content: 'old answer',
                    toolCalls: [{ id: 'old-call', name: 'search', args: { query: 'old' } }],
                },
                { role: 'tool_result', toolCallId: 'old-call', content: '{"ok":true}' },
                { role: 'user', content: 'new question' },
            ],
            tools: [{
                name: 'search', description: 'Search calendars.',
                parameters: { type: 'object', properties: { query: { type: 'string' } } },
            }],
        }, delta => deltas.push(delta))

        expect(deltas).toEqual(['Checking ', 'now.'])
        expect(result).toEqual({
            message: {
                role: 'assistant', content: 'Checking now.',
                toolCalls: [{ id: 'call-1', name: 'search', args: { query: 'calendar' } }],
            },
            stopReason: 'tool_use',
            usage: {
                inputTokens: 12, outputTokens: 4, cacheReadTokens: 8, cacheWriteTokens: 2,
            },
            responseId: 'resp-next',
        })
        const [path, init] = request.mock.calls[0] as [string, RequestInit]
        expect(path).toBe('/responses')
        const body = JSON.parse(String(init.body))
        expect(body).toMatchObject({
            model: 'gpt-test',
            instructions: 'Use tools.',
            previous_response_id: 'resp-previous',
            reasoning: { effort: 'medium' },
            stream: true,
        })
        expect(body.input).toEqual([
            { role: 'user', content: [{ type: 'input_text', text: 'old question' }] },
            { role: 'assistant', content: [{ type: 'output_text', text: 'old answer' }] },
            { type: 'function_call', call_id: 'old-call', name: 'search', arguments: '{"query":"old"}' },
            { type: 'function_call_output', call_id: 'old-call', output: '{"ok":true}' },
            { role: 'user', content: [{ type: 'input_text', text: 'new question' }] },
        ])
        expect(body.tools).toEqual([{
            type: 'function', name: 'search', description: 'Search calendars.',
            parameters: { type: 'object', properties: { query: { type: 'string' } } },
            strict: false,
        }])
    })

    it('uses Responses JSON schema output for structured calls', async () => {
        const request = vi.fn().mockResolvedValue(sse(
            { type: 'response.output_text.delta', delta: '{"answer":"ok"}' },
            completed(),
        ))
        const provider = new CodexSubscriptionProvider({ model: 'gpt-test', transport: { request } })
        const schema = {
            type: 'object' as const,
            properties: { answer: { type: 'string' as const } },
            required: ['answer'],
            additionalProperties: false,
        }
        await expect(provider.structured<{ answer: string }>({
            system: 'Return JSON.', messages: [{ role: 'user', content: 'answer' }], schema,
        })).resolves.toEqual({
            value: { answer: 'ok' },
            usage: { inputTokens: 12, outputTokens: 4, cacheReadTokens: 8, cacheWriteTokens: 2 },
        })
        const body = JSON.parse(String((request.mock.calls[0]?.[1] as RequestInit).body))
        expect(body.text.format).toEqual({
            type: 'json_schema', name: 'structured_output', schema, strict: true,
        })
        expect(body.tools).toBeUndefined()
    })

    it('maps incomplete output and rejects failed or malformed protocol responses', async () => {
        const responses = [
            sse(completed({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })),
            sse({ type: 'response.failed', response: { status: 'failed', error: { message: 'denied' } } }),
            sse({ type: 'response.output_item.done', item: {
                type: 'function_call', call_id: 'call-1', name: 'search', arguments: '{bad',
            } }, completed()),
            sse({ type: 'response.output_text.delta', delta: 'partial' }),
        ]
        const transport: CodexSubscriptionTransport = {
            async request() { return responses.shift()! },
        }
        const provider = new CodexSubscriptionProvider({ model: 'gpt-test', transport })

        await expect(provider.turn({ messages: [{ role: 'user', content: 'one' }] }))
            .resolves.toMatchObject({ stopReason: 'max_tokens' })
        await expect(provider.turn({ messages: [{ role: 'user', content: 'two' }] }))
            .rejects.toThrow('response failed: denied')
        await expect(provider.turn({ messages: [{ role: 'user', content: 'three' }] }))
            .rejects.toBeInstanceOf(LLMProtocolError)
        await expect(provider.turn({ messages: [{ role: 'user', content: 'four' }] }))
            .rejects.toThrow('ended before completion')
    })

    it('forwards cancellation and rejects unsupported capabilities before transport access', async () => {
        const request = vi.fn((_path: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        }))
        const provider = new CodexSubscriptionProvider({ model: 'gpt-test', transport: { request } })
        const controller = new AbortController()
        const pending = provider.turn(
            { messages: [{ role: 'user', content: 'wait' }] },
            { signal: controller.signal },
        )
        controller.abort(new Error('cancelled'))
        await expect(pending).rejects.toThrow('cancelled')

        request.mockClear()
        await expect(provider.turn({
            messages: [{ role: 'user', content: 'stop' }], stopSequences: ['DONE'],
        })).rejects.toThrow('stop sequences are not supported')
        expect(request).not.toHaveBeenCalled()
        expect(() => provider.embed(['text'])).toThrow('does not provide embeddings')
    })
})
