/**
 * Anthropic Claude provider — implements ILLMProvider via raw HTTP.
 *
 * Uses native fetch (Node ≥ 18) — no SDK dependency.
 *
 * Structured output is implemented via tool-use forcing: a synthetic tool
 * is defined with the caller's schema and the model is required to call it.
 * This is the recommended approach for guaranteed JSON output on Claude.
 */

import type {
    ILLMProvider,
    StructuredRequest,
    StructuredResponse,
    TurnRequest,
    TurnResponse,
    Message,
    AssistantMessage,
    ToolCall,
    TokenUsage,
    ToolDefinition,
    StopReason,
} from '../contracts/llm.js'
import type { JsonSchema } from '../contracts/shared.js'
import {
    retryDelayFromHeaders,
    sleep,
    waitForRequestSlot,
    pushBackRequestSlot,
} from './resilient-fetch.js'

// ── Config ─────────────────────────────────────────────────────────────────────

export interface AnthropicConfig {
    /** Anthropic API key. Falls back to AGENTIC_ANTHROPIC_API_KEY when omitted. */
    apiKey?:   string
    /** Model ID, e.g. 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'. */
    model:     string
    /** Max tokens to generate. Default: 4096. */
    maxTokens?: number
    /** Override API base URL (useful for proxies / testing). */
    baseUrl?:  string
    /** Called before each retry sleep. Useful for logging. */
    onRetry?:  (attempt: number, delayMs: number, status: number) => void
    /** Minimum spacing between request starts for this API key/base URL pair. Default: 1000 ms. */
    minRequestSpacingMs?: number
}

const API_BASE           = 'https://api.anthropic.com'
const API_VERSION        = '2023-06-01'
const DEFAULT_MAX_TOKENS = 4096
const DEFAULT_MIN_REQUEST_SPACING_MS = 1_000

// Retry on 429 / 529 (overloaded): exponential backoff with jitter.
const RETRY_STATUS  = new Set([429, 529])
const MAX_RETRIES   = 6
const MAX_DELAY_MS  = 60_000

/** Anthropic-specific reset headers checked during retry delay calculation. */
const ANTHROPIC_RESET_HEADERS = [
    'anthropic-ratelimit-requests-reset',
    'anthropic-ratelimit-tokens-reset',
]

// ── Anthropic wire types ───────────────────────────────────────────────────────

type AnthropicBlock =
    | { type: 'text';        text: string }
    | { type: 'tool_use';    id: string; name: string; input: Record<string, unknown> }
    | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

interface AnthropicMessage {
    role:    'user' | 'assistant'
    content: string | AnthropicBlock[]
}

interface AnthropicTool {
    name:         string
    description?: string
    input_schema: JsonSchema
}

interface AnthropicRequest {
    model:        string
    max_tokens:   number
    system?:      string
    messages:     AnthropicMessage[]
    tools?:       AnthropicTool[]
    tool_choice?: { type: 'auto' | 'any' | 'tool'; name?: string }
}

interface AnthropicResponse {
    content:     AnthropicBlock[]
    stop_reason: string
    usage: {
        input_tokens:                  number
        output_tokens:                 number
        cache_read_input_tokens?:      number
        cache_creation_input_tokens?:  number
    }
}

// ── Message conversion ─────────────────────────────────────────────────────────

function toAnthropicMessages(messages: Message[]): AnthropicMessage[] {
    const out: AnthropicMessage[] = []

    for (const msg of messages) {
        if (msg.role === 'user') {
            // Merge consecutive user messages — Anthropic requires strict alternation.
            const prev = out[out.length - 1]
            if (prev?.role === 'user' && typeof prev.content === 'string') {
                prev.content += '\n' + msg.content
            } else {
                out.push({ role: 'user', content: msg.content })
            }

        } else if (msg.role === 'assistant') {
            // Merge consecutive plain assistant messages.
            const prev = out[out.length - 1]
            if (!msg.toolCalls?.length && prev?.role === 'assistant' && typeof prev.content === 'string') {
                prev.content += '\n' + msg.content
            } else if (!msg.toolCalls?.length) {
                out.push({ role: 'assistant', content: msg.content })
            } else {
                const blocks: AnthropicBlock[] = []
                if (msg.content) blocks.push({ type: 'text', text: msg.content })
                for (const tc of msg.toolCalls) {
                    blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args })
                }
                out.push({ role: 'assistant', content: blocks })
            }

        } else {
            // tool_result — Anthropic requires tool results as user-turn content blocks.
            // Consecutive results are merged into one user message.
            const block: AnthropicBlock = {
                type:        'tool_result',
                tool_use_id: msg.toolCallId,
                content:     msg.content,
                ...(msg.isError ? { is_error: true } : {}),
            }
            const last = out[out.length - 1]
            if (last?.role === 'user' && Array.isArray(last.content)) {
                (last.content as AnthropicBlock[]).push(block)
            } else {
                out.push({ role: 'user', content: [block] })
            }
        }
    }

    return out
}

function toAnthropicTools(tools: ToolDefinition[]): AnthropicTool[] {
    return tools.map(t => ({
        name:         t.name,
        description:  t.description,
        input_schema: t.parameters,
    }))
}

function mapStopReason(raw: string): StopReason {
    switch (raw) {
        case 'end_turn':      return 'end_turn'
        case 'tool_use':      return 'tool_use'
        case 'max_tokens':    return 'max_tokens'
        case 'stop_sequence': return 'stop_sequence'
        default:              return 'end_turn'
    }
}

function extractUsage(u: AnthropicResponse['usage']): TokenUsage {
    return {
        inputTokens:      u.input_tokens,
        outputTokens:     u.output_tokens,
        cacheReadTokens:  u.cache_read_input_tokens,
        cacheWriteTokens: u.cache_creation_input_tokens,
    }
}

function fromAnthropicResponse(res: AnthropicResponse): { message: AssistantMessage; stopReason: StopReason; usage: TokenUsage } {
    const text:      string[]   = []
    const toolCalls: ToolCall[] = []

    for (const block of res.content) {
        if (block.type === 'text')     text.push(block.text)
        if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, args: block.input })
    }

    return {
        message: {
            role:      'assistant',
            content:   text.join(''),
            toolCalls: toolCalls.length ? toolCalls : undefined,
        },
        stopReason: mapStopReason(res.stop_reason),
        usage:      extractUsage(res.usage),
    }
}

// ── Provider ───────────────────────────────────────────────────────────────────

export class AnthropicProvider implements ILLMProvider {
    private readonly apiKey:    string
    private readonly model:     string
    private readonly maxTokens: number
    private readonly baseUrl:   string
    private readonly minRequestSpacingMs: number

    constructor(config: AnthropicConfig) {
        const apiKey = config.apiKey ?? process.env['AGENTIC_ANTHROPIC_API_KEY']
        if (!apiKey) throw new Error('AnthropicProvider: apiKey is required (or set AGENTIC_ANTHROPIC_API_KEY)')
        if (!config.model) throw new Error('AnthropicProvider: model is required')

        this.apiKey    = apiKey
        this.model     = config.model
        this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
        this.baseUrl   = config.baseUrl ?? API_BASE
        this.minRequestSpacingMs = config.minRequestSpacingMs ?? DEFAULT_MIN_REQUEST_SPACING_MS
        this.onRetry   = config.onRetry
    }

    private readonly onRetry?: AnthropicConfig['onRetry']

    private limiterKey(): string {
        return `${this.baseUrl}|${this.apiKey}`
    }

    /**
     * Structured output via tool-use forcing.
     * Defines a synthetic `structured_output` tool with the caller's schema
     * and requires the model to call it — guaranteeing schema-conformant JSON.
     */
    async structured<T>(request: StructuredRequest): Promise<StructuredResponse<T>> {
        const body: AnthropicRequest = {
            model:      this.model,
            max_tokens: this.maxTokens,
            system:     request.system,
            messages:   toAnthropicMessages(request.messages),
            tools: [{
                name:         'structured_output',
                description:  'Return the result as a structured JSON object.',
                input_schema: request.schema,
            }],
            tool_choice: { type: 'tool', name: 'structured_output' },
        }

        const res = await this.post<AnthropicResponse>('/v1/messages', body)

        const toolBlock = res.content.find(
            (b): b is AnthropicBlock & { type: 'tool_use' } =>
                b.type === 'tool_use' && b.name === 'structured_output',
        )
        if (!toolBlock) {
            throw new Error('AnthropicProvider: model did not call structured_output tool')
        }

        return {
            value: toolBlock.input as T,
            usage: extractUsage(res.usage),
        }
    }

    /** One agentic turn. The model may return text, tool calls, or both. */
    async turn(request: TurnRequest): Promise<TurnResponse> {
        const body: AnthropicRequest = {
            model:      this.model,
            max_tokens: request.maxTokens ?? this.maxTokens,
            system:     request.system,
            messages:   toAnthropicMessages(request.messages),
            ...(request.tools?.length
                ? { tools: toAnthropicTools(request.tools), tool_choice: { type: 'auto' } }
                : {}),
        }

        const res = await this.post<AnthropicResponse>('/v1/messages', body)
        return fromAnthropicResponse(res)
    }

    embed(_texts: string[]): Promise<number[][]> {
        throw new Error('AnthropicProvider: Anthropic does not provide an embeddings API')
    }

    private async post<T>(path: string, body: unknown): Promise<T> {
        const limiterKey = this.limiterKey()
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            await waitForRequestSlot(limiterKey, this.minRequestSpacingMs)
            const res = await fetch(`${this.baseUrl}${path}`, {
                method:  'POST',
                headers: {
                    'Content-Type':      'application/json',
                    'x-api-key':         this.apiKey,
                    'anthropic-version': API_VERSION,
                },
                body: JSON.stringify(body),
            })

            if (res.ok) return res.json() as Promise<T>

            if (RETRY_STATUS.has(res.status) && attempt < MAX_RETRIES) {
                const delay = retryDelayFromHeaders(res.headers, attempt, ANTHROPIC_RESET_HEADERS)
                this.onRetry?.(attempt + 1, delay, res.status)
                pushBackRequestSlot(limiterKey, delay)
                await res.body?.cancel()
                await sleep(delay)
                continue
            }

            const text = await res.text().catch(() => '(no body)')
            throw new Error(`AnthropicProvider: HTTP ${res.status} ${res.statusText} — ${text}`)
        }

        throw new Error('AnthropicProvider: max retries exceeded')
    }
}
