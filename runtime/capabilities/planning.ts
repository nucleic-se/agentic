/**
 * PlanningCapability — structured pre-flight planning via ILLMProvider.structured().
 *
 * Before each graph run, calls provider.structured() with a user message produced
 * by a caller-supplied state projection and writes the result to state[stateKey].
 *
 * Design decisions:
 *   - prompt(state) is a function, not a static string or a contextKey stringification,
 *     because what to send to the planner is always state-derived.
 *   - The plan lives in state[stateKey], not on the capability instance. This makes the
 *     capability safe to reuse across concurrent runs and keeps graph state authoritative.
 *   - afterRun clears state[stateKey] to undefined so stale plan data never leaks into
 *     the next run.
 *   - If structured() throws, fallback (if provided) is written to state[stateKey].
 *     If no fallback is provided, state[stateKey] is left unchanged (already undefined
 *     at run start, or whatever the caller initialised it to).
 *   - Planning is best-effort: errors are swallowed; the run continues without a plan.
 *
 * The capability has NO prompt contributor field. The plan in state[stateKey] is meant
 * to be consumed by the agent loop (e.g., read in a graph node or system prompt builder),
 * not injected automatically. This keeps the capability boundary clean.
 */

import type { ILLMProvider } from '../../contracts/llm.js'
import type { ICapability, ICapabilityLifecycle } from '../../contracts/ICapability.js'
import type { GraphState } from '../../contracts/graph/IGraphEngine.js'
import type { JsonSchema } from '../../contracts/shared.js'

// ── Config ────────────────────────────────────────────────────────────────────

export interface PlanningCapabilityConfig<TState extends GraphState = GraphState> {
    /** LLM provider used for the planning call. */
    provider: ILLMProvider
    /** System prompt for the planning call. */
    system: string
    /**
     * State projection: called with the current state to produce the user message
     * sent to the planner. Typically reads a memory document, task description, etc.
     */
    prompt(state: Readonly<TState>): string
    /** JSON schema for the plan output. */
    schema: JsonSchema
    /** State key to write the plan result to. Cleared to undefined after each run. */
    stateKey: keyof TState & string
    /**
     * Value to write when structured() throws (provider error, schema mismatch, etc.).
     * If omitted, state[stateKey] is left unchanged on error.
     */
    fallback?: unknown
}

// ── Implementation ────────────────────────────────────────────────────────────

export class PlanningCapability<TState extends GraphState = GraphState>
    implements ICapability<TState>
{
    readonly id: string
    readonly lifecycle: ICapabilityLifecycle<TState>

    constructor(config: PlanningCapabilityConfig<TState>, id = 'planning') {
        this.id = id

        this.lifecycle = {
            beforeRun: async (state: TState): Promise<void> => {
                try {
                    const result = await config.provider.structured({
                        system:   config.system,
                        messages: [{ role: 'user', content: config.prompt(state) }],
                        schema:   config.schema,
                    })
                    ;(state as Record<string, unknown>)[config.stateKey] = result.value
                } catch {
                    if (config.fallback !== undefined) {
                        ;(state as Record<string, unknown>)[config.stateKey] = config.fallback
                    }
                }
            },

            afterRun: async (state: TState): Promise<void> => {
                ;(state as Record<string, unknown>)[config.stateKey] = undefined
            },
        }
    }
}
