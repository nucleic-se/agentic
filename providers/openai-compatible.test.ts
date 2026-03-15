import { afterEach, describe, expect, it, vi } from 'vitest'

import { OpenAICompatibleProvider } from './openai-compatible.js'
import { OLLAMA_LOCAL_API_BASE, OllamaProvider } from './ollama.js'
import { retryDelay, retryDelayFromHeaders, parseResetHeader } from './resilient-fetch.js'

describe('OpenAICompatibleProvider', () => {
    afterEach(() => {
        vi.restoreAllMocks()
        delete process.env['AGENTIC_OLLAMA_API_KEY']
        delete process.env['AGENTIC_OPENAI_API_KEY']
        delete process.env['AGENTIC_OPENAI_BASE_URL']
    })

    it('structured() sends json_schema response format and parses JSON content', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            choices: [{
                finish_reason: 'stop',
                message: { role: 'assistant', content: '{"answer":"ok"}' },
            }],
            usage: { prompt_tokens: 12, completion_tokens: 4 },
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }))
        vi.stubGlobal('fetch', fetchMock)

        const provider = new OpenAICompatibleProvider({
            baseUrl:      'http://localhost:11434/v1',
            model:        'qwen3-coder:480b',
            providerName: 'TestProvider',
        })

        const result = await provider.structured<{ answer: string }>({
            system: 'return json',
            messages: [{ role: 'user', content: 'hi' }],
            schema: {
                type: 'object',
                properties: { answer: { type: 'string' } },
                required: ['answer'],
                additionalProperties: false,
            },
        })

        expect(result.value).toEqual({ answer: 'ok' })
        expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 4 })

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
        expect(url).toBe('http://localhost:11434/v1/chat/completions')
        expect(init.method).toBe('POST')

        const body = JSON.parse(String(init.body))
        expect(body.response_format).toEqual({
            type: 'json_schema',
            json_schema: {
                name: 'structured_output',
                schema: {
                    type: 'object',
                    properties: { answer: { type: 'string' } },
                    required: ['answer'],
                    additionalProperties: false,
                },
                strict: true,
            },
        })
        expect(body.messages[0]).toEqual({ role: 'system', content: 'return json' })
        expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' })
    })

    it('turn() sends tools and maps tool_calls back into the contract', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            choices: [{
                finish_reason: 'tool_calls',
                message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{
                        id: 'call_123',
                        type: 'function',
                        function: {
                            name: 'search',
                            arguments: '{"query":"ollama"}',
                        },
                    }],
                },
            }],
            usage: { prompt_tokens: 30, completion_tokens: 10 },
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }))
        vi.stubGlobal('fetch', fetchMock)

        const provider = new OpenAICompatibleProvider({
            apiKey:       'secret',
            baseUrl:      'http://localhost:11434/v1',
            model:        'qwen3-coder:480b',
            providerName: 'TestProvider',
        })

        const result = await provider.turn({
            system: 'use tools',
            messages: [
                { role: 'user', content: 'look something up' },
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [{ id: 'call_old', name: 'search', args: { query: 'prev' } }],
                },
                { role: 'tool_result', toolCallId: 'call_old', content: '{"ok":true}' },
            ],
            tools: [{
                name: 'search',
                description: 'Search docs',
                parameters: {
                    type: 'object',
                    properties: { query: { type: 'string' } },
                    required: ['query'],
                },
            }],
            stopSequences: ['DONE'],
            maxTokens: 200,
        })

        expect(result.stopReason).toBe('tool_use')
        expect(result.message.toolCalls).toEqual([{
            id: 'call_123',
            name: 'search',
            args: { query: 'ollama' },
        }])
        expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 10 })

        const [_, init] = fetchMock.mock.calls[0] as [string, RequestInit]
        expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer secret')

        const body = JSON.parse(String(init.body))
        expect(body.stop).toEqual(['DONE'])
        expect(body.max_tokens).toBe(200)
        expect(body.tools).toHaveLength(1)
        expect(body.messages[1]).toEqual({
            role: 'user',
            content: 'look something up',
        })
        expect(body.messages[2]).toEqual({
            role: 'assistant',
            content: null,
            tool_calls: [{
                id: 'call_old',
                type: 'function',
                function: {
                    name: 'search',
                    arguments: '{"query":"prev"}',
                },
            }],
        })
        expect(body.messages[3]).toEqual({
            role: 'tool',
            tool_call_id: 'call_old',
            content: '{"ok":true}',
        })
    })

    it('embed() calls the embeddings endpoint', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            data: [
                { embedding: [0.1, 0.2] },
                { embedding: [0.3, 0.4] },
            ],
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }))
        vi.stubGlobal('fetch', fetchMock)

        const provider = new OpenAICompatibleProvider({
            baseUrl:        'http://localhost:11434/v1',
            model:          'qwen3-coder:480b',
            embeddingModel: 'qwen3-embedding',
        })

        await expect(provider.embed(['a', 'b'])).resolves.toEqual([
            [0.1, 0.2],
            [0.3, 0.4],
        ])

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
        expect(url).toBe('http://localhost:11434/v1/embeddings')
        expect(JSON.parse(String(init.body))).toEqual({
            model: 'qwen3-embedding',
            input: ['a', 'b'],
        })
    })
})

describe('OllamaProvider', () => {
    afterEach(() => {
        vi.restoreAllMocks()
        delete process.env['AGENTIC_OLLAMA_API_KEY']
        delete process.env['AGENTIC_OLLAMA_BASE_URL']
    })

    it('defaults to the local v1 base and AGENTIC_OLLAMA_API_KEY', async () => {
        process.env['AGENTIC_OLLAMA_API_KEY'] = 'ollama-secret'

        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            choices: [{
                finish_reason: 'stop',
                message: { role: 'assistant', content: '{"ok":true}' },
            }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }))
        vi.stubGlobal('fetch', fetchMock)

        const provider = new OllamaProvider({ model: 'qwen3-coder:480b' })
        await provider.structured({
            messages: [{ role: 'user', content: 'hi' }],
            schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
        })

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
        expect(url).toBe(`${OLLAMA_LOCAL_API_BASE}/chat/completions`)
        expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer ollama-secret')
    })

    it('passes numCtx as options.num_ctx in the request body', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            choices: [{
                finish_reason: 'stop',
                message: { role: 'assistant', content: 'hello' },
            }],
            usage: { prompt_tokens: 5, completion_tokens: 1 },
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }))
        vi.stubGlobal('fetch', fetchMock)

        const provider = new OllamaProvider({ model: 'gemma3:27b', numCtx: 32768 })
        await provider.turn({
            messages: [{ role: 'user', content: 'hi' }],
        })

        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
        const body = JSON.parse(String(init.body))
        expect(body.options).toEqual({ num_ctx: 32768 })
    })
})

describe('resilient-fetch', () => {
    describe('retryDelay', () => {
        it('produces exponential delays capped at maxDelayMs', () => {
            // Delay has jitter, so check the range
            for (let i = 0; i < 20; i++) {
                const d = retryDelay(0, 2000, 60000)
                expect(d).toBeGreaterThanOrEqual(2000)
                expect(d).toBeLessThanOrEqual(2400)  // 2000 + 20% jitter
            }
            // Attempt 5 → 2000*32 = 64000, capped to 60000
            const d5 = retryDelay(5, 2000, 60000)
            expect(d5).toBeLessThanOrEqual(72000)  // 60000 + 20%
        })
    })

    describe('parseResetHeader', () => {
        it('returns null for null/empty', () => {
            expect(parseResetHeader(null)).toBeNull()
            expect(parseResetHeader('')).toBeNull()
        })

        it('parses delta-seconds', () => {
            const result = parseResetHeader('5')
            expect(result).toBe(5000)
        })

        it('parses HTTP-date strings', () => {
            const future = new Date(Date.now() + 10_000).toUTCString()
            const result = parseResetHeader(future)
            expect(result).toBeGreaterThan(0)
            expect(result).toBeLessThanOrEqual(11_000)
        })
    })

    describe('retryDelayFromHeaders', () => {
        it('prefers retry-after-ms header', () => {
            const headers = new Headers({ 'retry-after-ms': '3500' })
            expect(retryDelayFromHeaders(headers, 0)).toBe(3500)
        })

        it('uses retry-after (seconds) when retry-after-ms is absent', () => {
            const headers = new Headers({ 'retry-after': '2' })
            expect(retryDelayFromHeaders(headers, 0)).toBe(2000)
        })

        it('falls back to exponential backoff when no headers present', () => {
            const delay = retryDelayFromHeaders(new Headers(), 0)
            expect(delay).toBeGreaterThanOrEqual(2000)
            expect(delay).toBeLessThanOrEqual(2400)
        })
    })
})

describe('OpenAICompatibleProvider retry', () => {
    afterEach(() => { vi.restoreAllMocks() })

    it('retries on 503 and succeeds on the second attempt', async () => {
        const retryCallback = vi.fn()
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response('Service Unavailable', {
                status: 503,
                statusText: 'Service Unavailable',
            }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                choices: [{
                    finish_reason: 'stop',
                    message: { role: 'assistant', content: 'hello' },
                }],
                usage: { prompt_tokens: 5, completion_tokens: 1 },
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
        vi.stubGlobal('fetch', fetchMock)

        const provider = new OpenAICompatibleProvider({
            baseUrl: 'http://localhost:11434/v1',
            model:   'test-model',
            retry:   { onRetry: retryCallback, baseDelayMs: 10, maxDelayMs: 50 },
        })

        const result = await provider.turn({
            messages: [{ role: 'user', content: 'hi' }],
        })

        expect(result.message.content).toBe('hello')
        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(retryCallback).toHaveBeenCalledWith(1, expect.any(Number), 503)
    })

    it('throws on non-retryable status (400)', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response('bad request', { status: 400, statusText: 'Bad Request' }),
        )
        vi.stubGlobal('fetch', fetchMock)

        const provider = new OpenAICompatibleProvider({
            baseUrl: 'http://localhost:11434/v1',
            model:   'test-model',
        })

        await expect(provider.turn({
            messages: [{ role: 'user', content: 'hi' }],
        })).rejects.toThrow('HTTP 400')

        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('retries on 429 and respects retry-after header', async () => {
        const retryCallback = vi.fn()
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response('rate limited', {
                status: 429,
                statusText: 'Too Many Requests',
                headers: { 'retry-after': '1' },
            }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                choices: [{
                    finish_reason: 'stop',
                    message: { role: 'assistant', content: 'ok' },
                }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
        vi.stubGlobal('fetch', fetchMock)

        const provider = new OpenAICompatibleProvider({
            baseUrl: 'http://localhost:11434/v1',
            model:   'test-model',
            retry:   { onRetry: retryCallback, maxDelayMs: 2000 },
        })

        const result = await provider.turn({
            messages: [{ role: 'user', content: 'hi' }],
        })

        expect(result.message.content).toBe('ok')
        expect(retryCallback).toHaveBeenCalledWith(1, 1000, 429)
    })
})
