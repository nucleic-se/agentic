/**
 * Tool policy contract.
 *
 * IToolPolicy is the formal safety layer between context assembly and tool
 * execution. Before a tool call is dispatched to IToolRuntime, the policy
 * decides whether it should proceed, be rewritten, be denied, or require
 * confirmation.
 *
 * Design principles:
 *
 *   - Policy evaluates intent, not implementation. It receives the planned
 *     call (name + args + trust tier) and returns a decision. It does not
 *     execute the tool.
 *
 *   - 'deny' maps to a synthetic ToolResultMessage in the conversation.
 *     The LLM sees the denial reason and can adapt. A denial is not an
 *     agent error — it is policy working correctly.
 *
 *   - 'rewrite' modifies args before execution. The rewritten args are used
 *     for execution and recorded in the execution store alongside the original.
 *
 *   - 'confirm' is a signal to the caller to pause and await user input.
 *     The mechanism for confirmation is caller-defined (the policy contract
 *     does not own the interaction channel).
 *
 *   - Policy is stateless per call. Session-level rate limiting or call
 *     budgets require the implementation to carry state externally.
 *
 * @module contracts
 */

import type { ToolTrustTier } from './ITool.js'

// ── Context ───────────────────────────────────────────────────────────────────

export interface PolicyContext {
    /** LLM-assigned call ID for this tool invocation. */
    callId:    string
    /** Name of the tool being invoked. */
    name:      string
    /** Arguments proposed by the model. */
    args:      Record<string, unknown>
    /**
     * Trust tier of the tool as registered in IToolRegistry.
     * 'trusted' — internal/deterministic; 'standard' — caller-provided;
     * 'untrusted' — external APIs, internet content.
     */
    trustTier: ToolTrustTier
}

// ── Decision ──────────────────────────────────────────────────────────────────

export type PolicyDecision =
    /** Allow the call to proceed with the original args. */
    | { kind: 'allow' }
    /** Allow the call, but substitute rewritten args. The reason is logged. */
    | { kind: 'rewrite'; args: Record<string, unknown>; reason: string }
    /** Block the call. A synthetic error result is returned to the model. */
    | { kind: 'deny';    reason: string }
    /**
     * Pause and request confirmation before proceeding.
     * The calling agent is responsible for surfacing this to the user and
     * resuming the execution loop with the decision.
     */
    | { kind: 'confirm'; reason: string }

// ── Contract ──────────────────────────────────────────────────────────────────

export interface IToolPolicy {
    /**
     * Evaluate a proposed tool call and return a decision.
     * Never throws — errors in policy evaluation should be surfaced as 'deny'.
     */
    evaluate(context: PolicyContext): Promise<PolicyDecision>
}
