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
     */
    call(name: string, args: Record<string, unknown>): Promise<ToolCallResult>
}
