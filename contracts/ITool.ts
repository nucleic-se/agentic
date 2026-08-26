/**
 * Typed tool system contracts.
 *
 * Structured tool definitions with executable schemas, trust tiers, and
 * provenance. Replaces stringly-typed ToolFunction where runtime validation is required.
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

// ── Runtime schemas ────────────────────────────────────────────

export interface ValidationIssue {
    readonly message: string;
    readonly path?: ReadonlyArray<string | number>;
}

export type ValidationResult<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/**
 * A library-neutral executable schema.
 *
 * `jsonSchema` is sent to the model. `validate` is the authority at the
 * runtime boundary. Agentic deliberately does not depend on a schema library;
 * callers may implement this contract directly or adapt their validator of
 * choice outside Agentic.
 */
export interface RuntimeSchema<T> {
    readonly jsonSchema: JsonSchema;
    validate(value: unknown): ValidationResult<T>;
}

export interface ToolExecutionContext {
    readonly callId: string;
    readonly signal: AbortSignal;
    readonly onUpdate?: (details: unknown) => void;
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
    readonly input: RuntimeSchema<TInput>;
    readonly output?: RuntimeSchema<TOutput>;
    readonly trustTier: ToolTrustTier;
    readonly timeoutMs?: number;
    execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
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
