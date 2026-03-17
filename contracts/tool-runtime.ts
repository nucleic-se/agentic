/**
 * Tool runtime contract.
 *
 * IToolRuntime is the interface between an agent loop and the tools
 * available to it. The runtime owns tool discovery, dispatch, and
 * error normalisation; callers just invoke and observe results.
 *
 * Design principles:
 *
 *   - `call()` never throws. Errors are surfaced as ok: false + content.
 *     The caller can always pass the result back to the LLM unchanged.
 *
 *   - `content` is the text the LLM sees. It should be terse and informative.
 *     Successful outputs: the data. Errors: what failed and why.
 *
 *   - `data` is optional structured output for programmatic inspection
 *     without parsing text.
 *
 *   - Tools are registered, not injected per call. The runtime is constructed
 *     once and reused across turns or workflow steps.
 *
 *   - `signal` and `onUpdate` in ToolCallOptions are optional and additive.
 *     Runtimes that do not support cancellation or streaming silently ignore them.
 */

import type { ToolDefinition } from './llm.js'

// ── Result ────────────────────────────────────────────────────────────────────

export interface ToolCallResult {
    ok:       boolean
    /** Text representation for LLM consumption. Always present. */
    content:  string
    /** Structured data for programmatic access. Optional. */
    data?:    unknown
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface ToolCallOptions {
    /**
     * Cancellation signal. If fired before the tool returns, the runtime
     * should abort in-progress work and return ok: false with an appropriate
     * content message. Runtimes that cannot honour cancellation may ignore this.
     */
    signal?: AbortSignal
    /**
     * Progress callback for streaming or long-running tools. Called zero or
     * more times before the final result. `details` is tool-defined; callers
     * should treat it as opaque unless they own the tool implementation.
     */
    onUpdate?: (details: unknown) => void
}

// ── Runtime ───────────────────────────────────────────────────────────────────

export interface IToolRuntime {
    /**
     * List all tools available in this runtime, with their schemas.
     * Pass the result directly to TurnRequest.tools.
     */
    tools(): ToolDefinition[]

    /**
     * Execute a named tool call. Never throws.
     * Unknown tool name → ok: false, content: 'Unknown tool: <name>'.
     * Options are additive: runtimes that do not support signal or onUpdate ignore them.
     */
    call(name: string, args: Record<string, unknown>, options?: ToolCallOptions): Promise<ToolCallResult>
}
