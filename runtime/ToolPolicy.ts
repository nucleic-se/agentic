/**
 * Tool policy runtime implementations.
 *
 * Two default policies shipped with the library:
 *
 *   PassThroughToolPolicy  — allows all calls; suitable for Phase A / trusted environments
 *   TrustTierToolPolicy    — denies unknown tools; allows known tools by default;
 *                            subclass to add call-budget or domain restrictions
 *
 * @module runtime
 */

import type { IToolPolicy, PolicyContext, PolicyDecision } from '../contracts/IToolPolicy.js'
import type { IToolRegistry } from '../contracts/ITool.js'

// ── Pass-through ──────────────────────────────────────────────────────────────

/**
 * Allows every call unconditionally. Suitable for controlled environments
 * where all tools are trusted and policy enforcement is not needed.
 */
export class PassThroughToolPolicy implements IToolPolicy {
    async evaluate(_context: PolicyContext): Promise<PolicyDecision> {
        return { kind: 'allow' }
    }
}

// ── Trust-tier ────────────────────────────────────────────────────────────────

/**
 * Denies calls to unknown tools (not registered in IToolRegistry).
 * Allows all known tools regardless of trust tier.
 *
 * Extend this class to add tier-specific rules, call budgets,
 * domain allow/deny lists, or confirmation gates.
 *
 * @example
 * class StrictPolicy extends TrustTierToolPolicy {
 *   async evaluate(ctx: PolicyContext): Promise<PolicyDecision> {
 *     if (ctx.trustTier === 'untrusted') return { kind: 'confirm', reason: 'External content' }
 *     return super.evaluate(ctx)
 *   }
 * }
 */
export class TrustTierToolPolicy implements IToolPolicy {
    constructor(private readonly registry: IToolRegistry) {}

    async evaluate(context: PolicyContext): Promise<PolicyDecision> {
        const tool = this.registry.resolve(context.name)
        if (!tool) {
            return { kind: 'deny', reason: `Unknown tool: ${context.name}` }
        }
        return { kind: 'allow' }
    }
}
