/**
 * OpenAI-compatible provider — implements ILLMProvider against hosts that
 * expose the OpenAI chat completions and embeddings endpoints.
 */

import type {
    AssistantMessage,
    ILLMProvider,
    Message,
    StopReason,
    StructuredRequest,
    StructuredResponse,
    TokenUsage,
    ToolCall,
    ToolDefinition,
    TurnRequest,
    TurnResponse,
} from '../contracts/llm.js'
import type { JsonSchema } from '../contracts/shared.js'
import { resilientPost, type RetryConfig } from './resilient-fetch.js'

export interface OpenAICompatibleConfig {
    /** API key. Falls back to AGENTIC_OPENAI_API_KEY when omitted. */
    apiKey?: string
    /** Chat model ID. */
    model: string
    /** Embedding model ID. Defaults to the chat model. */
    embeddingModel?: string
    /** Base URL without trailing slash. Falls back to AGENTIC_OPENAI_BASE_URL when omitted. */
    baseUrl?: string
    /** Optional provider name used in error messages. */
    providerName?: string
    /** Optional extra headers for gateway/proxy integrations. */
    headers?: Record<string, string>
    /**
     * Extra fields merged into the chat completion request body.
     * Use for provider-specific options (e.g. Ollama's `options.num_ctx`).
     */
    extraBody?: Record<string, unknown>
    /** Retry configuration for transient HTTP errors (429, 502, 503, 529). */
    retry?: RetryConfig
}

type OpenAIRole = 'system' | 'user' | 'assistant' | 'tool'

interface OpenAIFunctionTool {
    type: 'function'
    function: {
        name: string
        description?: string
        parameters: JsonSchema
    }
}

interface OpenAIToolCallWire {
    id?: string
    type?: 'function'
    function?: {
        name?: string
        arguments?: string
    }
}

interface OpenAIMessage {
    role: OpenAIRole
    content: string | null
    tool_call_id?: string
    name?: string
    tool_calls?: OpenAIToolCallWire[]
}

interface OpenAIChatRequest {
    model: string
    messages: OpenAIMessage[]
    stream: boolean
    stream_options?: { include_usage: boolean }
    tools?: OpenAIFunctionTool[]
    tool_choice?: 'auto' | { type: 'function'; function: { name: string } }
    response_format?: {
        type: 'json_schema' | 'json_object'
        json_schema?: {
            name: string
            schema: JsonSchema
            strict?: boolean
        }
    }
    stop?: string[]
    max_tokens?: number
}

interface OpenAIStreamDelta {
    choices?: Array<{
        delta?: {
            content?: string | null
            tool_calls?: Array<{
                index?: number
                id?: string
                type?: 'function'
                function?: {
                    name?: string
                    arguments?: string
                }
            }>
        }
        finish_reason?: string | null
    }>
    usage?: OpenAIChatResponse['usage']
}

interface OpenAIChatResponse {
    choices?: Array<{
        finish_reason?: string | null
        message?: {
            role?: 'assistant'
            content?: string | null
            tool_calls?: OpenAIToolCallWire[]
        }
    }>
    usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        total_tokens?: number
    }
}

interface OpenAIEmbeddingResponse {
    data?: Array<{ embedding?: number[] }>
}

function toOpenAITools(tools: ToolDefinition[]): OpenAIFunctionTool[] {
    return tools.map(tool => ({
        type: 'function',
        function: {
            name:        tool.name,
            description: tool.description,
            parameters:  tool.parameters,
        },
    }))
}

function toOpenAIMessages(system: string | undefined, messages: Message[]): OpenAIMessage[] {
    const out: OpenAIMessage[] = []

    if (system) out.push({ role: 'system', content: system })

    for (const msg of messages) {
        if (msg.role === 'user') {
            // Merge consecutive user messages — some providers (Ollama, Anthropic)
            // require strict user/assistant alternation.
            const prev = out[out.length - 1]
            if (prev?.role === 'user') {
                prev.content += '\n' + msg.content
            } else {
                out.push({ role: 'user', content: msg.content })
            }
            continue
        }

        if (msg.role === 'assistant') {
            // Merge consecutive assistant messages (same rationale).
            const prev = out[out.length - 1]
            if (prev?.role === 'assistant' && !msg.toolCalls?.length && !prev.tool_calls?.length) {
                prev.content += '\n' + (msg.content || '')
            } else {
                out.push({
                    role:       'assistant',
                    content:    msg.content || '',
                    ...(msg.toolCalls?.length
                        ? {
                            tool_calls: msg.toolCalls.map(call => ({
                                id:   call.id,
                                type: 'function' as const,
                                function: {
                                    name:      call.name,
                                    arguments: JSON.stringify(call.args),
                                },
                            })),
                        }
                        : {}),
                })
            }
            continue
        }

        out.push({
            role:         'tool',
            tool_call_id: msg.toolCallId,
            content:      msg.content,
        })
    }

    return out
}

function normalizeToolArgs(value: string | undefined, fallbackName: string): Record<string, unknown> {
    if (!value) return {}

    try {
        const parsed = JSON.parse(value)
        return typeof parsed === 'object' && parsed != null ? parsed as Record<string, unknown> : {}
    } catch {
        throw new Error(`OpenAICompatibleProvider: invalid JSON arguments for tool ${fallbackName}`)
    }
}

function extractUsage(usage: OpenAIChatResponse['usage']): TokenUsage {
    return {
        inputTokens:  usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
    }
}

function mapStopReason(raw: string | null | undefined, toolCalls: ToolCall[]): StopReason {
    if (raw === 'length') return 'max_tokens'
    if (raw === 'stop') return toolCalls.length ? 'tool_use' : 'end_turn'
    if (raw === 'tool_calls') return 'tool_use'
    return toolCalls.length ? 'tool_use' : 'end_turn'
}

function fromOpenAIResponse(res: OpenAIChatResponse): TurnResponse {
    const choice = res.choices?.[0]
    const message = choice?.message
    if (!message) throw new Error('OpenAICompatibleProvider: missing response message')

    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((call, index) => ({
        id:   call.id ?? `tool-call-${index}`,
        name: call.function?.name ?? `tool_${index}`,
        args: normalizeToolArgs(call.function?.arguments, call.function?.name ?? `tool_${index}`),
    }))

    const assistant: AssistantMessage = {
        role:      'assistant',
        content:   message.content ?? '',
        toolCalls: toolCalls.length ? toolCalls : undefined,
    }

    return {
        message: assistant,
        stopReason: mapStopReason(choice?.finish_reason, toolCalls),
        usage:      extractUsage(res.usage),
    }
}

export class OpenAICompatibleProvider implements ILLMProvider {
    protected readonly apiKey?: string
    protected readonly model: string
    protected readonly embeddingModel: string
    protected readonly baseUrl: string
    protected readonly providerName: string
    protected readonly headers: Record<string, string>
    protected readonly extraBody: Record<string, unknown>
    protected readonly retryConfig: RetryConfig

    constructor(config: OpenAICompatibleConfig) {
        if (!config.model) throw new Error('OpenAICompatibleProvider: model is required')
        const baseUrl = config.baseUrl ?? process.env['AGENTIC_OPENAI_BASE_URL']
        if (!baseUrl) throw new Error('OpenAICompatibleProvider: baseUrl is required (or set AGENTIC_OPENAI_BASE_URL)')

        this.apiKey = config.apiKey ?? process.env['AGENTIC_OPENAI_API_KEY']
        this.model = config.model
        this.embeddingModel = config.embeddingModel ?? config.model
        this.baseUrl = baseUrl.replace(/\/$/, '')
        this.providerName = config.providerName ?? 'OpenAICompatibleProvider'
        this.headers = config.headers ?? {}
        this.extraBody = config.extraBody ?? {}
        this.retryConfig = config.retry ?? {}
    }

    async structured<T>(request: StructuredRequest): Promise<StructuredResponse<T>> {
        const body: OpenAIChatRequest = {
            model:    this.model,
            messages: toOpenAIMessages(request.system, request.messages),
            stream:   false,
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name:   'structured_output',
                    schema: request.schema,
                    strict: true,
                },
            },
        }

        const res = await this.post<OpenAIChatResponse>('/chat/completions', { ...body, ...this.extraBody })
        const content = res.choices?.[0]?.message?.content
        if (!content) {
            throw new Error(`${this.providerName}: structured response was empty`)
        }

        try {
            return {
                value: parseStructuredContent<T>(content),
                usage: extractUsage(res.usage),
            }
        } catch {
            throw new Error(`${this.providerName}: structured response was not valid JSON: ${content}`)
        }
    }

    async turn(request: TurnRequest): Promise<TurnResponse> {
        const body: OpenAIChatRequest = {
            model:      this.model,
            messages:   toOpenAIMessages(request.system, request.messages),
            stream:     false,
            ...(request.tools?.length
                ? {
                    tools: toOpenAITools(request.tools),
                    tool_choice: 'auto' as const,
                }
                : {}),
            ...(request.stopSequences?.length ? { stop: request.stopSequences } : {}),
            ...(request.maxTokens != null ? { max_tokens: request.maxTokens } : {}),
        }

        const res = await this.post<OpenAIChatResponse>('/chat/completions', { ...body, ...this.extraBody })
        return fromOpenAIResponse(res)
    }

    async streamTurn(request: TurnRequest, onDelta: (text: string) => void): Promise<TurnResponse> {
        const body: OpenAIChatRequest = {
            model:      this.model,
            messages:   toOpenAIMessages(request.system, request.messages),
            stream:     true,
            stream_options: { include_usage: true },
            ...(request.tools?.length
                ? {
                    tools: toOpenAITools(request.tools),
                    tool_choice: 'auto' as const,
                }
                : {}),
            ...(request.stopSequences?.length ? { stop: request.stopSequences } : {}),
            ...(request.maxTokens != null ? { max_tokens: request.maxTokens } : {}),
        }

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...this.headers,
        }
        if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`

        const res = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ ...body, ...this.extraBody }),
        })
        if (!res.ok) {
            const text = await res.text().catch(() => '(no body)')
            throw new Error(`${this.providerName}: HTTP ${res.status} ${res.statusText} — ${text}`)
        }
        if (!res.body) throw new Error(`${this.providerName}: streaming response has no body`)

        // Accumulate content + tool calls from SSE deltas.
        let content = ''
        let finishReason: string | null = null
        let usage: OpenAIChatResponse['usage'] = undefined
        const toolCallAccum = new Map<number, { id: string; name: string; args: string }>()

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''

            for (const line of lines) {
                const trimmed = line.trim()
                if (!trimmed || !trimmed.startsWith('data: ')) continue
                const payload = trimmed.slice(6)
                if (payload === '[DONE]') continue

                let chunk: OpenAIStreamDelta
                try { chunk = JSON.parse(payload) } catch { continue }

                const choice = chunk.choices?.[0]
                if (choice?.delta?.content) {
                    content += choice.delta.content
                    onDelta(choice.delta.content)
                }

                // Accumulate tool call deltas by index.
                if (choice?.delta?.tool_calls) {
                    for (const tc of choice.delta.tool_calls) {
                        const idx = tc.index ?? 0
                        const existing = toolCallAccum.get(idx)
                        if (!existing) {
                            toolCallAccum.set(idx, {
                                id:   tc.id ?? `tool-call-${idx}`,
                                name: tc.function?.name ?? '',
                                args: tc.function?.arguments ?? '',
                            })
                        } else {
                            if (tc.id) existing.id = tc.id
                            if (tc.function?.name) existing.name += tc.function.name
                            existing.args += tc.function?.arguments ?? ''
                        }
                    }
                }

                if (choice?.finish_reason) finishReason = choice.finish_reason
                if (chunk.usage) usage = chunk.usage
            }
        }

        const toolCalls: ToolCall[] = [...toolCallAccum.values()].map(tc => ({
            id:   tc.id,
            name: tc.name,
            args: normalizeToolArgs(tc.args || undefined, tc.name),
        }))

        const assistant: AssistantMessage = {
            role:      'assistant',
            content,
            toolCalls: toolCalls.length ? toolCalls : undefined,
        }

        return {
            message:    assistant,
            stopReason: mapStopReason(finishReason, toolCalls),
            usage:      extractUsage(usage),
        }
    }

    async embed(texts: string[]): Promise<number[][]> {
        const res = await this.post<OpenAIEmbeddingResponse>('/embeddings', {
            model: this.embeddingModel,
            input: texts,
        })

        const vectors = res.data?.map(item => item.embedding).filter((value): value is number[] => Array.isArray(value))
        if (!vectors?.length) throw new Error(`${this.providerName}: embed response missing embeddings`)
        return vectors
    }

    protected async post<T>(path: string, body: unknown): Promise<T> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...this.headers,
        }
        if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`

        return resilientPost<T>(
            `${this.baseUrl}${path}`,
            { method: 'POST', headers, body: JSON.stringify(body) },
            this.providerName,
            this.retryConfig,
        )
    }
}

function parseStructuredContent<T>(content: string): T {
    const candidates = [
        content.trim(),
        stripCodeFence(content),
        extractFirstJsonValue(content),
    ].filter((value): value is string => typeof value === 'string' && value.trim() !== '')

    for (const candidate of candidates) {
        try {
            return JSON.parse(candidate) as T
        } catch {
            continue
        }
    }

    throw new Error('invalid structured JSON')
}

function stripCodeFence(content: string): string | null {
    const match = content.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
    return match?.[1]?.trim() || null
}

function extractFirstJsonValue(content: string): string | null {
    for (let i = 0; i < content.length; i++) {
        const start = content[i]
        if (start !== '{' && start !== '[') continue

        const candidate = scanBalancedJson(content, i)
        if (candidate) return candidate
    }
    return null
}

function scanBalancedJson(content: string, startIndex: number): string | null {
    const opening = content[startIndex]
    const closing = opening === '{' ? '}' : ']'
    let depth = 0
    let inString = false
    let escaped = false

    for (let i = startIndex; i < content.length; i++) {
        const char = content[i]

        if (inString) {
            if (escaped) {
                escaped = false
            } else if (char === '\\') {
                escaped = true
            } else if (char === '"') {
                inString = false
            }
            continue
        }

        if (char === '"') {
            inString = true
            continue
        }
        if (char === opening) depth++
        if (char === closing) {
            depth--
            if (depth === 0) {
                return content.slice(startIndex, i + 1).trim()
            }
        }
    }

    return null
}
