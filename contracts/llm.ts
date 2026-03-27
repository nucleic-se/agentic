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

import type { JsonSchema } from './shared.js'

// ── Messages ──────────────────────────────────────────────────────────────────

export type MessageProvenance = 'human' | 'model' | 'deterministic'

export interface UserMessage {
    role:       'user'
    content:    string
    provenance?: MessageProvenance
}

export interface AssistantMessage {
    role:       'assistant'
    content:    string
    toolCalls?: ToolCall[]
    provenance?: MessageProvenance
}

export interface ToolResultMessage {
    role:        'tool_result'
    toolCallId:  string
    content:     string
    provenance?: MessageProvenance
    /** True when the tool itself returned an error — the LLM should see this as a failure. */
    isError?:   boolean
}

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
}

// ── Structured output ─────────────────────────────────────────────────────────

export interface StructuredRequest {
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
    system?:         string
    messages:        Message[]
    tools?:          ToolDefinition[]
    stopSequences?:  string[]
    /** Max tokens to generate. Provider default if omitted. */
    maxTokens?:      number
}

export interface TurnResponse {
    message:    AssistantMessage
    stopReason: StopReason
    usage:      TokenUsage
}

// ── Provider ──────────────────────────────────────────────────────────────────

export interface ILLMProvider {
    /**
     * Single-call structured completion. The model must not call tools.
     * The provider forwards the supplied JSON Schema to the backing API/model
     * and returns the parsed result. Schema enforcement depends on provider
     * capabilities; implementations may not perform client-side validation.
     */
    structured<T>(request: StructuredRequest): Promise<StructuredResponse<T>>

    /**
     * One turn of an agentic conversation. The model may return text,
     * tool calls, or both. The caller is responsible for executing tool
     * calls (via IToolRuntime) and looping until stopReason = 'end_turn'.
     */
    turn(request: TurnRequest): Promise<TurnResponse>

    /**
     * Streaming variant of turn(). Calls onDelta with text chunks as they
     * arrive, then resolves with the complete TurnResponse. Optional —
     * callers should fall back to turn() when not implemented.
     */
    streamTurn?(request: TurnRequest, onDelta: (text: string) => void): Promise<TurnResponse>

    /**
     * Embed one or more texts. Returns one vector per input.
     */
    embed(texts: string[]): Promise<number[][]>
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
