/**
 * Capability contracts — Wave 2.
 *
 * ICapability is the bundle unit that the composition layer (Wave 3) will
 * orchestrate. A capability can contribute a prompt section, a tool runtime,
 * and lifecycle hooks — all expressed through existing interfaces.
 *
 * Scope discipline: no produces/consumes, no conflict metadata, no registry
 * fields. Those are only designable once real implementations exist.
 *
 * @module contracts
 */

import type { IPromptContributor } from './IPromptEngine.js'
import type { IToolRuntime } from './tool-runtime.js'
import type { TurnRecord } from './agent.js'
import type { GraphState } from './graph/IGraphEngine.js'

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export interface ICapabilityLifecycle<TState extends GraphState = GraphState> {
    /**
     * Called once before the graph run starts.
     * Use to initialise state, run structured planning calls, load context, etc.
     */
    beforeRun?(state: TState): Promise<void>

    /**
     * Called after each completed turn, before the next one starts.
     * Use to inject budget hints, nudges, or per-turn bookkeeping.
     */
    afterTurn?(state: TState, turn: TurnRecord): Promise<void>

    /**
     * Called once after the graph run completes (whether it ended normally or was stopped).
     * Use to persist results, flush caches, or reset internal state.
     */
    afterRun?(state: TState): Promise<void>
}

// ── Capability ────────────────────────────────────────────────────────────────

export interface ICapability<TState extends GraphState = GraphState> {
    /** Unique identifier for this capability. */
    readonly id: string

    /**
     * IDs of capabilities that must be activated before this one.
     * Ordering is resolved by the capability registry (Wave 3).
     * Forward references are allowed.
     */
    readonly after?: readonly string[]

    /**
     * If provided, called to determine whether this capability participates in the
     * current run. Inactive capabilities contribute no prompt, runtime, or lifecycle.
     * If absent the capability is always active.
     */
    active?(state: Readonly<TState>): boolean

    /** Prompt contributor to merge into the prompt when this capability is active. */
    readonly prompt?: IPromptContributor

    /** Tool runtime to merge into the composite runtime when this capability is active. */
    readonly runtime?: IToolRuntime

    /** Lifecycle hooks. */
    readonly lifecycle?: ICapabilityLifecycle<TState>
}
