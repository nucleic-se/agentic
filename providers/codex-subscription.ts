import { createOpenAIOAuthTransport, type OpenAIOAuth, type OpenAIOAuthTransport } from '@openai-oauth/core'
import { openaiCredentials } from '@openai-oauth/local'

import {
    LLMProtocolError,
    type AssistantMessage,
    type ILLMProvider,
    type Message,
    type ProviderCallOptions,
    type StopReason,
    type StructuredRequest,
    type StructuredResponse,
    type TokenUsage,
    type ToolCall,
    type ToolDefinition,
    type TurnRequest,
    type TurnResponse,
} from '../contracts/llm.js'
import type { JsonSchema } from '../contracts/shared.js'
import { providerSignal } from './cancellation.js'

type JsonRecord = Record<string, unknown>

export interface CodexSubscriptionTransport {
    request(path: string, init?: RequestInit): Promise<Response>
}

export interface CodexSubscriptionConfig {
    model: string
    /** Local Codex auth.json path. Defaults to CODEX_HOME or ~/.codex/auth.json. */
    authFilePath?: string
    /** Inject an alternative OAuth credential source. */
    credentials?: OpenAIOAuth
    /** Inject the authenticated Responses transport, primarily for composition and tests. */
    transport?: CodexSubscriptionTransport
    baseUrl?: string
    fetch?: typeof fetch
    headers?: Record<string, string>
    providerName?: string
    reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh'
    verbosity?: 'low' | 'medium' | 'high'
}

interface ResponseInputText {
    type: 'input_text' | 'output_text'
    text: string
}

type ResponseInputItem =
    | { role: 'user' | 'assistant'; content: ResponseInputText[] }
    | { type: 'function_call'; call_id: string; name: string; arguments: string }
    | { type: 'function_call_output'; call_id: string; output: string }

interface ResponseFunctionTool {
    type: 'function'
    name: string
    description: string
    parameters: JsonSchema
    strict: false
}

interface ParsedResponse {
    id?: string
    content: string
    toolCalls: ToolCall[]
    stopReason: StopReason
    usage: TokenUsage
}

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalRecord(value: unknown): JsonRecord | undefined {
    return isRecord(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined
}

function toInput(messages: Message[]): ResponseInputItem[] {
    const input: ResponseInputItem[] = []
    for (const message of messages) {
        if (message.role === 'user') {
            input.push({ role: 'user', content: [{ type: 'input_text', text: message.content }] })
            continue
        }
        if (message.role === 'tool_result') {
            input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content })
            continue
        }
        if (message.content) {
            input.push({ role: 'assistant', content: [{ type: 'output_text', text: message.content }] })
        }
        for (const call of message.toolCalls ?? []) {
            input.push({
                type: 'function_call',
                call_id: call.id,
                name: call.name,
                arguments: JSON.stringify(call.args),
            })
        }
    }
    return input
}

function toTools(tools: ToolDefinition[] | undefined): ResponseFunctionTool[] | undefined {
    if (!tools?.length) return undefined
    return tools.map(tool => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        // Agentic validates every call before execution. Do not claim that an
        // arbitrary caller schema satisfies the provider's strict-schema subset.
        strict: false,
    }))
}

function usageFrom(value: unknown): TokenUsage {
    const usage = optionalRecord(value)
    const inputDetails = optionalRecord(usage?.input_tokens_details)
    return {
        inputTokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0,
        outputTokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0,
        ...(typeof inputDetails?.cached_tokens === 'number'
            ? { cacheReadTokens: inputDetails.cached_tokens }
            : {}),
        ...(typeof inputDetails?.cache_write_tokens === 'number'
            ? { cacheWriteTokens: inputDetails.cache_write_tokens }
            : {}),
    }
}

function parseArguments(raw: string, name: string, usage: TokenUsage): Record<string, unknown> {
    try {
        const value: unknown = JSON.parse(raw || '{}')
        if (!isRecord(value)) throw new Error('arguments must be an object')
        return value
    } catch (cause) {
        throw new LLMProtocolError(
            `CodexSubscriptionProvider: malformed arguments for tool '${name}'`,
            { cause, usage },
        )
    }
}

function stopReasonFor(response: JsonRecord, toolCalls: ToolCall[]): StopReason {
    if (toolCalls.length) return 'tool_use'
    const status = asString(response.status)
    const incomplete = optionalRecord(response.incomplete_details)
    if (status === 'incomplete' && incomplete?.reason === 'max_output_tokens') return 'max_tokens'
    return 'end_turn'
}

function eventBlocks(buffer: string): { blocks: string[]; remainder: string } {
    const parts = buffer.split(/\r?\n\r?\n/)
    return { blocks: parts.slice(0, -1), remainder: parts.at(-1) ?? '' }
}

function eventData(block: string): string | undefined {
    const values = block.split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
    return values.length ? values.join('\n') : undefined
}

function terminalFailure(response: JsonRecord, usage: TokenUsage): LLMProtocolError | undefined {
    const status = asString(response.status)
    if (status === 'completed' || status === 'incomplete') return undefined
    const error = optionalRecord(response.error)
    const detail = asString(error?.message) ?? status ?? 'unknown failure'
    return new LLMProtocolError(`CodexSubscriptionProvider: response failed: ${detail}`, { usage })
}

async function parseResponseStream(
    response: Response,
    onDelta: (text: string) => void,
    providerName: string,
): Promise<ParsedResponse> {
    if (!response.ok) {
        const text = await response.text().catch(() => '(no body)')
        throw new Error(`${providerName}: HTTP ${response.status} ${response.statusText} — ${text}`)
    }
    if (!response.body) throw new LLMProtocolError(`${providerName}: response had no body`)

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const calls = new Map<string, { name: string; arguments: string }>()
    let buffer = ''
    let content = ''
    let completed: JsonRecord | undefined

    const consume = (block: string): void => {
        const data = eventData(block)
        if (!data || data === '[DONE]') return
        let event: JsonRecord
        try {
            const parsed: unknown = JSON.parse(data)
            if (!isRecord(parsed)) return
            event = parsed
        } catch {
            throw new LLMProtocolError(`${providerName}: invalid JSON in response stream`)
        }
        const type = asString(event.type)
        if (type === 'response.output_text.delta') {
            const delta = asString(event.delta)
            if (delta) {
                content += delta
                onDelta(delta)
            }
            return
        }
        if (type === 'response.output_item.done') {
            const item = optionalRecord(event.item)
            if (item?.type !== 'function_call') return
            const callId = asString(item.call_id)
            const name = asString(item.name)
            const args = asString(item.arguments)
            if (!callId || !name || args === undefined) {
                throw new LLMProtocolError(`${providerName}: incomplete function call item`)
            }
            calls.set(callId, { name, arguments: args })
            return
        }
        if (type === 'response.completed' || type === 'response.incomplete' ||
            type === 'response.failed' || type === 'response.cancelled' || type === 'response.canceled') {
            completed = optionalRecord(event.response) ?? event
            return
        }
        if (type === 'error') {
            const message = asString(event.message) ?? asString(optionalRecord(event.error)?.message) ?? 'stream error'
            throw new LLMProtocolError(`${providerName}: ${message}`)
        }
    }

    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const parsed = eventBlocks(buffer)
            buffer = parsed.remainder
            for (const block of parsed.blocks) consume(block)
        }
        buffer += decoder.decode()
        if (buffer.trim()) consume(buffer)
    } finally {
        reader.releaseLock()
    }

    if (!completed) throw new LLMProtocolError(`${providerName}: response stream ended before completion`)
    const usage = usageFrom(completed.usage)
    const failure = terminalFailure(completed, usage)
    if (failure) throw failure
    const toolCalls = [...calls.entries()].map(([id, call]) => ({
        id,
        name: call.name,
        args: parseArguments(call.arguments, call.name, usage),
    }))
    return {
        id: asString(completed.id),
        content,
        toolCalls,
        stopReason: stopReasonFor(completed, toolCalls),
        usage,
    }
}

/** Direct ChatGPT subscription provider using the Codex Responses transport. */
export class CodexSubscriptionProvider implements ILLMProvider {
    readonly #model: string
    readonly #transport: CodexSubscriptionTransport
    readonly #providerName: string
    readonly #reasoningEffort: NonNullable<CodexSubscriptionConfig['reasoningEffort']>
    readonly #verbosity: NonNullable<CodexSubscriptionConfig['verbosity']>

    constructor(config: CodexSubscriptionConfig) {
        if (!config.model) throw new TypeError('CodexSubscriptionProvider: model is required')
        this.#model = config.model
        this.#providerName = config.providerName ?? 'Codex subscription'
        this.#reasoningEffort = config.reasoningEffort ?? 'low'
        this.#verbosity = config.verbosity ?? 'low'
        if (config.transport) {
            this.#transport = config.transport
        } else {
            const credentials = config.credentials ?? openaiCredentials({
                authFilePath: config.authFilePath,
                baseURL: config.baseUrl,
                fetch: config.fetch,
                headers: config.headers,
            })
            this.#transport = createOpenAIOAuthTransport({
                auth: () => credentials.getSession(),
                baseURL: credentials.baseURL ?? config.baseUrl,
                fetch: credentials.fetch ?? config.fetch,
                headers: credentials.headers ?? config.headers,
            }) satisfies OpenAIOAuthTransport
        }
    }

    async #request(
        request: TurnRequest,
        onDelta: (text: string) => void,
        options?: ProviderCallOptions,
        textFormat?: JsonRecord,
    ): Promise<ParsedResponse> {
        if (request.stopSequences?.length) {
            throw new Error(`${this.#providerName}: stop sequences are not supported by the Responses transport`)
        }
        const tools = toTools(request.tools)
        const body = {
            model: this.#model,
            instructions: request.system ?? '',
            input: toInput(request.messages),
            stream: true,
            store: false,
            reasoning: { effort: this.#reasoningEffort },
            text: {
                format: textFormat ?? { type: 'text' },
                verbosity: this.#verbosity,
            },
            ...(tools ? { tools, tool_choice: 'auto' } : {}),
            ...(request.maxTokens !== undefined ? { max_output_tokens: request.maxTokens } : {}),
            ...(request.previousResponseId ? { previous_response_id: request.previousResponseId } : {}),
        }
        const response = await this.#transport.request('/responses', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: providerSignal(options),
        })
        return parseResponseStream(response, onDelta, this.#providerName)
    }

    async structured<T>(
        request: StructuredRequest,
        options?: ProviderCallOptions,
    ): Promise<StructuredResponse<T>> {
        const parsed = await this.#request(
            request,
            () => {},
            options,
            { type: 'json_schema', name: 'structured_output', schema: request.schema, strict: true },
        )
        try {
            return { value: JSON.parse(parsed.content) as T, usage: parsed.usage }
        } catch (cause) {
            throw new LLMProtocolError(
                `${this.#providerName}: structured response was not valid JSON`,
                { cause, usage: parsed.usage },
            )
        }
    }

    async turn(request: TurnRequest, options?: ProviderCallOptions): Promise<TurnResponse> {
        return this.streamTurn(request, () => {}, options)
    }

    async streamTurn(
        request: TurnRequest,
        onDelta: (text: string) => void,
        options?: ProviderCallOptions,
    ): Promise<TurnResponse> {
        const parsed = await this.#request(request, onDelta, options)
        const message: AssistantMessage = {
            role: 'assistant',
            content: parsed.content,
            ...(parsed.toolCalls.length ? { toolCalls: parsed.toolCalls } : {}),
        }
        return {
            message,
            stopReason: parsed.stopReason,
            usage: parsed.usage,
            ...(parsed.id ? { responseId: parsed.id } : {}),
        }
    }

    embed(_texts: string[], _options?: ProviderCallOptions): Promise<number[][]> {
        throw new Error(`${this.#providerName}: Codex subscription does not provide embeddings`)
    }
}
