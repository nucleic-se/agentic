/**
 * BudgetHintCapability — injects turn-budget awareness into the conversation.
 *
 * After each turn, checks the ratio of used turns to the configured maximum.
 * At configured thresholds (default: 75%, 90%, final turn), appends a sticky
 * user message to state[messagesKey] so the model knows to wrap up.
 *
 * Concurrent-run safety: which thresholds have fired is tracked per run
 * via a WeakMap keyed on the initial state object. Each call to engine.run()
 * passes a distinct state object, so concurrent runs never interfere.
 * The WeakMap entry is garbage-collected when the state object is GC'd.
 *
 * Each threshold fires at most once per run. Hints are sticky so the
 * conversation assembler never drops them.
 *
 * Ported from evolve-lab's budget hint logic.
 */

import type { ICapability, ICapabilityLifecycle } from '../../contracts/ICapability.js'
import type { GraphState } from '../../contracts/graph/IGraphEngine.js'
import type { TurnRecord } from '../../contracts/agent.js'
import type { UserMessage } from '../../contracts/llm.js'

// ── Config ────────────────────────────────────────────────────────────────────

export interface BudgetHintThreshold {
    /**
     * Fire when usedTurns / maxTurns >= pct.
     * Use 1.0 to target the final turn.
     */
    pct: number
    /**
     * The message to inject. If a function, called with (remaining, used, max)
     * to produce the content string.
     */
    message: string | ((remaining: number, used: number, max: number) => string)
}

export interface BudgetHintCapabilityConfig<TState extends GraphState = GraphState> {
    /** Maximum turns allowed for this run. */
    maxTurns: number
    /** State key holding the current turn count (number). */
    turnCountKey: keyof TState & string
    /** State key holding the message array (Message[]) to append hints to. */
    messagesKey: keyof TState & string
    /**
     * Hint thresholds and messages. Evaluated highest-pct-first; each fires at most once per run.
     * Default: 75% → "start planning wrap-up", 90% → "begin wrapping up", final → "complete now".
     */
    thresholds?: BudgetHintThreshold[]
}

/** Default three-tier thresholds (descending pct order for priority). */
const DEFAULT_THRESHOLDS: BudgetHintThreshold[] = [
    {
        pct: 1.0,
        message: (_remaining, used, max) =>
            `[Budget: final turn (${used}/${max}). Complete your response now — no more tool calls.]`,
    },
    {
        pct: 0.9,
        message: (remaining, used, max) =>
            `[Budget: ${remaining} turn${remaining !== 1 ? 's' : ''} remaining (${used}/${max} used). Begin wrapping up soon.]`,
    },
    {
        pct: 0.75,
        message: (remaining, used, max) =>
            `[Budget: ${remaining} turn${remaining !== 1 ? 's' : ''} remaining (${used}/${max} used). Start planning your wrap-up.]`,
    },
]

// ── Implementation ────────────────────────────────────────────────────────────

export class BudgetHintCapability<TState extends GraphState = GraphState>
    implements ICapability<TState>
{
    readonly id: string
    readonly lifecycle: ICapabilityLifecycle<TState>

    // Per-run fired tracking: keyed on the state object passed to each run.
    // Distinct state objects per concurrent run → no cross-run interference.
    readonly #firedByRun = new WeakMap<object, Set<number>>()

    constructor(config: BudgetHintCapabilityConfig<TState>, id = 'budget-hint') {
        this.id = id

        // Sort highest-pct first so the most urgent unfired threshold fires each turn
        const thresholds = [...(config.thresholds ?? DEFAULT_THRESHOLDS)].sort(
            (a, b) => b.pct - a.pct,
        )

        this.lifecycle = {
            afterTurn: async (state: TState, _turn: TurnRecord): Promise<void> => {
                // Get or create the per-run fired set for this state object
                let fired = this.#firedByRun.get(state as object)
                if (!fired) {
                    fired = new Set()
                    this.#firedByRun.set(state as object, fired)
                }

                const used      = Number((state as Record<string, unknown>)[config.turnCountKey] ?? 0)
                const max       = config.maxTurns
                if (max <= 0) return

                const remaining = max - used
                const pct       = used / max

                for (let i = 0; i < thresholds.length; i++) {
                    const threshold = thresholds[i]!
                    if (fired.has(i)) continue
                    if (pct < threshold.pct) continue

                    const content = typeof threshold.message === 'function'
                        ? threshold.message(remaining, used, max)
                        : threshold.message

                    const hintMsg: UserMessage = { role: 'user', content, sticky: true }
                    const messages = (state as Record<string, unknown>)[config.messagesKey]
                    if (Array.isArray(messages)) {
                        messages.push(hintMsg)
                    }

                    fired.add(i)
                    break // one hint per turn
                }
            },
        }
    }
}
