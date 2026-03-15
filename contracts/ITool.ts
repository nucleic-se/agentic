/**
 * Typed tool system contracts.
 *
 * Structured tool definitions with schemas, trust tiers, provenance,
 * rate limits, and retry policies. Replaces stringly-typed ToolFunction
 * for production use.
 *
 * @module contracts
 */

import type { JsonSchema } from './shared.js';

// ── Trust ──────────────────────────────────────────────────────

export type ToolTrustTier =
    /** Internal deterministic tools (clock, math, format). */
    | 'trusted'
    /** Caller-provided tools with known schemas. */
    | 'standard'
    /** External APIs, web fetch, anything from the internet. */
    | 'untrusted';

// ── Policies ───────────────────────────────────────────────────

export interface RetryPolicy {
    maxRetries: number;
    initialDelayMs: number;
    /** Multiplier applied to delay after each retry. Default: 2.0. */
    backoffMultiplier?: number;
}

export interface RateLimit {
    maxCallsPerTurn?: number;
    maxCallsPerSession?: number;
}

// ── Tool ───────────────────────────────────────────────────────

/**
 * A typed, schema-governed tool that an agent can invoke.
 *
 * Tools are narrow and single-purpose. A host runtime mediates
 * all calls; the model never executes tools directly.
 *
 * @typeParam TInput  - The shape of the tool's input.
 * @typeParam TOutput - The shape of the tool's output.
 */
export interface ITool<TInput = unknown, TOutput = unknown> {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: JsonSchema;
    readonly outputSchema?: JsonSchema;
    readonly trustTier: ToolTrustTier;
    readonly timeoutMs?: number;
    readonly retryPolicy?: RetryPolicy;
    readonly rateLimit?: RateLimit;
    execute(input: TInput): Promise<TOutput>;
}

// ── Result ─────────────────────────────────────────────────────

/**
 * Envelope wrapping every tool result with provenance.
 * Injected into prompts under an explicit trust-tier label.
 */
export interface ToolResult<TOutput = unknown> {
    readonly toolName: string;
    readonly requestId: string;
    readonly timestamp: number;
    readonly latencyMs: number;
    readonly trustTier: ToolTrustTier;
    readonly status: 'ok' | 'error' | 'timeout' | 'rate_limited';
    readonly data: TOutput;
    readonly error?: string;
    /** URL or service name for external tools. */
    readonly source?: string;
}

// ── Registry ───────────────────────────────────────────────────

export interface IToolRegistry {
    /** Register a tool. Throws on duplicate name. */
    register(tool: ITool): void;
    /** Resolve a tool by name, or undefined if not found. */
    resolve(name: string): ITool | undefined;
    /** List all registered tools. */
    list(): ITool[];
}
