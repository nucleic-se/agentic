/**
 * LLM provider contracts — v2.
 *
 * Two distinct interaction patterns:
 *
 *   structured<T>()  — single call, JSON schema output, no tools.
 *                       Used by planning and evaluation nodes (intake, design, verify).
 *
 *   turn()           — one agentic turn; may return text, tool calls, or both.
 *                       Used by execute nodes. The caller drives the loop.
 *
 * The separation is intentional. Structured output and tool-calling are different
 * guarantees: providers can implement both independently, and callers declare
 * which contract they need at the call site.
 */

import type { JsonSchema, JsonValue } from './shared.js'

/** Provider/adaptor response violated the semantic LLM protocol. */
export class LLMProtocolError extends Error {
    readonly usage?: TokenUsage

    constructor(message: string, options?: ErrorOptions & { usage?: TokenUsage }) {
        super(message, options)
        this.name = 'LLMProtocolError'
        this.usage = options?.usage
    }
}

/** A caller-owned hard request ceiling was exceeded before transport access. */
export class LLMRequestBudgetError extends Error {
    constructor(
        readonly budget: number,
        readonly estimatedTokens: number,
    ) {
        super(`Provider request requires approximately ${estimatedTokens} tokens but the budget is ${budget}`)
        this.name = 'LLMRequestBudgetError'
    }
}

// ── Messages ──────────────────────────────────────────────────────────────────

export type MessageProvenance = 'human' | 'model' | 'deterministic'

export interface UserMessage {
    role:       'user'
    content:    string
    provenance?: MessageProvenance
    /** When true, this message is never dropped by the conversation assembler. */
    sticky?:    boolean
}

export interface AssistantMessage {
    role:       'assistant'
    content:    string
    toolCalls?: ToolCall[]
    provenance?: MessageProvenance
    /** Opaque protocol state for replay, owned by the provider adapter.
     * Persist with this message; discard when rewriting its content or tool calls.
     * Context assembly counts it and retains/drops it with the message. */
    continuation?: ProviderContinuation
}

/** Serializable continuation, without exposing a backend library's message types. */
export interface ProviderContinuation {
    /** Versioned encoding understood by the adapter. Unknown formats are ignored. */
    format: string
    /** Provider/API/model/deployment identity. Never replay to a different backend. */
    identity: string
    /** Adapter-generated binding to the visible text and tool calls. */
    contentHash: string
    /** Protocol annotations only; do not duplicate the visible message or transcript. */
    data: JsonValue
    /** Adapter estimate of additional input context beyond visible text/tool calls.
     * Advisory, not billable usage or a guaranteed bound. Missing uses serialized fallback. */
    estimatedInputTokens?: number
}

export interface ToolResultMessage {
    role:        'tool_result'
    toolCallId:  string
    /** Name of the tool that produced this result. Used by the conversation assembler for tool-aware compression. */
    toolName?:   string
    content:     string
    /** Native multimodal tool output. Text content remains the fallback representation. */
    contentBlocks?: ToolContentBlock[]
    provenance?: MessageProvenance
    /** True when the tool itself returned an error — the LLM should see this as a failure. */
    isError?:   boolean
}

export type ToolContentBlock =
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }

export type Message = UserMessage | AssistantMessage | ToolResultMessage

// ── Tools ─────────────────────────────────────────────────────────────────────

export interface ToolCall {
    id:   string
    name: string
    args: Record<string, unknown>
}

export interface ToolDefinition {
    name:        string
    description: string
    parameters:  JsonSchema
}

// ── Token usage ───────────────────────────────────────────────────────────────

export interface TokenUsage {
    inputTokens:       number
    outputTokens:      number
    cacheReadTokens?:  number
    cacheWriteTokens?: number
    reasoningTokens?: number
    totalTokens?: number
    costUsd?: number
}

// ── Structured output ─────────────────────────────────────────────────────────

export interface StructuredRequest {
    /** Opaque, stable caller-owned scope for provider cache/routing hints.
     * Providers may ignore it. It is not conversation history or an isolation boundary. */
    cacheScope?: string
    /** Requested output allowance. Check capabilities.outputLimit for enforcement. */
    maxTokens?: number
    system?:   string
    /**
     * Conversation messages. Minimum: a single user message.
     * Include previous assistant/user turns to provide retry context.
     */
    messages:  Message[]
    /**
     * JSON Schema forwarded to the backing API/model to shape the response.
     * Enforcement is best-effort and depends on provider capabilities.
     */
    schema:    JsonSchema
}

export interface StructuredResponse<T> {
    value: T
    usage: TokenUsage
}

// ── Agentic turn ──────────────────────────────────────────────────────────────

export type StopReason =
    | 'end_turn'        // model finished naturally
    | 'tool_use'        // model wants to call tools — caller executes and continues
    | 'max_tokens'      // context limit hit
    | 'stop_sequence'   // a stop sequence was matched

export interface TurnRequest {
    /** Opaque, stable caller-owned scope for provider cache/routing hints.
     * Providers may ignore it. It is not conversation history or an isolation boundary. */
    cacheScope?: string
    system?:         string
    messages:        Message[]
    tools?:          ToolDefinition[]
    stopSequences?:  string[]
    /** Requested output allowance. Check capabilities.outputLimit for enforcement. */
    maxTokens?:      number
    /**
     * Opaque ID of the immediately preceding provider response. Providers
     * that support continuation may use this instead of replaying history.
     * Callers must still supply the new messages and unchanged tool settings.
     */
    previousResponseId?: string
}

export interface TurnResponse {
    message:    AssistantMessage
    stopReason: StopReason
    usage:      TokenUsage
    /** Opaque ID that may be supplied as previousResponseId on the next turn. */
    responseId?: string
}

/** Cancellation and deadline shared by every provider operation. */
export interface ProviderCallOptions {
    signal?: AbortSignal
    /** Absolute Unix timestamp in milliseconds. */
    deadline?: number
    /** Awaited before transport when supported; observes final decoded request data. */
    onRequest?: (request: ProviderRequestObservation) => void | Promise<void>
}

// ── Provider ──────────────────────────────────────────────────────────────────

/** Effective adapter behavior. Absence means unknown, never an implied guarantee. */
export interface ProviderCapabilities {
    /** Known context capacity for this model and endpoint, including output. Missing means unknown. */
    contextWindowTokens?: number
    transport: string
    toolBatching: boolean
    outputLimit: 'enforced' | 'advisory'
    automaticRetries: number
    continuation: 'message' | 'response-id' | 'none'
    requestObservation: 'decoded-wire' | 'none'
}

/** Decoded request after backend normalization. Credentials and headers are excluded. */
export interface ProviderRequestObservation {
    url: string
    body: JsonValue
}

export interface ILLMProvider {
    /** Stable, non-secret identity of effective provider configuration for persistence.
     * Include adapter-owned model, deployment and behavior settings; exclude credentials
     * and observers. Callers must identify opaque behavioral overrides separately.
     * Must remain stable for this instance. Omit when the adapter cannot describe its
     * configuration; durable compositions then need a caller-owned identity.
     * This is separate from compatibility of provider continuation data. */
    readonly configurationIdentity?: string
    readonly capabilities?: Readonly<ProviderCapabilities>
    /**
     * Single-call structured completion without executing application tools.
     * The adapter supplies the JSON Schema through native structured output or
     * a schema tool and returns the parsed result. Schema enforcement depends on provider
     * capabilities; implementations may not perform client-side validation.
     */
    structured<T>(request: StructuredRequest, options?: ProviderCallOptions): Promise<StructuredResponse<T>>

    /**
     * One turn of an agentic conversation. The model may return text,
     * tool calls, or both. The caller is responsible for executing tool
     * calls (via IToolRuntime) and looping until stopReason = 'end_turn'.
     */
    turn(request: TurnRequest, options?: ProviderCallOptions): Promise<TurnResponse>

    /**
     * Streaming variant of turn(). Calls onDelta with text chunks as they
     * arrive, then resolves with the complete TurnResponse. Optional —
     * callers should fall back to turn() when not implemented.
     */
    streamTurn?(request: TurnRequest, onDelta: (text: string) => void, options?: ProviderCallOptions): Promise<TurnResponse>

    /**
     * Embed one or more texts. Returns one vector per input.
     */
    /** Optional compatibility capability; require IEmbeddingProvider when embedding is necessary. */
    embed?(texts: string[], options?: ProviderCallOptions): Promise<number[][]>
}

/** Explicit capability for consumers that require embeddings. */
export interface IEmbeddingProvider {
    embed(texts: string[], options?: ProviderCallOptions): Promise<number[][]>
}

// ── Model router ──────────────────────────────────────────────────────────────

/**
 * Selects a provider by capability tier.
 * The engine starts each node at its phase-appropriate tier and escalates on retry.
 */
export type ModelTier = 'fast' | 'balanced' | 'capable'

export interface IModelRouter {
    select(tier: ModelTier): ILLMProvider
}
