/**
 * EmptyResponseCapability — handles consecutive empty LLM turns gracefully.
 *
 * After each turn, checks if the assistant returned nothing (no text content,
 * no tool calls). On empty turns, increments state[emptyCountKey] and injects
 * a context-aware nudge as a sticky user message. After maxRetries consecutive
 * empty turns, sets state[doneKey] = true (if configured) to signal the loop to stop.
 *
 * The empty count lives in state[emptyCountKey], not on the capability instance.
 * This makes the capability safe to reuse across concurrent runs without interference.
 *
 * Nudge selection is context-aware:
 *   - If the last few messages include tool_results → model is mid-task → use nudgeMidRun.
 *   - Otherwise → model appears to be wrapping up → use nudgeFinal.
 *
 * The consecutive empty counter resets to zero on any non-empty turn.
 *
 * Ported from evolve-lab's empty response handling logic.
 */

import type { ICapability, ICapabilityLifecycle } from '../../contracts/ICapability.js'
import type { GraphState } from '../../contracts/graph/IGraphEngine.js'
import type { TurnRecord } from '../../contracts/agent.js'
import type { UserMessage } from '../../contracts/llm.js'

// ── Config ────────────────────────────────────────────────────────────────────

export interface EmptyResponseCapabilityConfig<TState extends GraphState = GraphState> {
    /** State key holding the message array (Message[]) to append nudges to. */
    messagesKey: keyof TState & string
    /**
     * State key to track consecutive empty turn count.
     * Lives in state so concurrent runs are independent and count survives checkpoints.
     */
    emptyCountKey: keyof TState & string
    /**
     * State key to set to true when max retries are exceeded.
     * If omitted, the capability only nudges without setting a done flag.
     */
    doneKey?: keyof TState & string
    /**
     * Max consecutive empty turns before giving up.
     * Default: 2.
     */
    maxRetries?: number
    /**
     * Nudge injected when the model appears to be mid-task (recent tool_results present).
     */
    nudgeMidRun?: string
    /**
     * Nudge injected when the model appears to be wrapping up (no recent tool_results).
     */
    nudgeFinal?: string
    /**
     * How many recent messages to inspect for tool_results when deciding which nudge to use.
     * Default: 6.
     */
    recentWindow?: number
}

const DEFAULT_NUDGE_MID_RUN =
    '[Your last response was empty. Please continue — use a tool call or write your next step.]'

const DEFAULT_NUDGE_FINAL =
    '[Your last response was empty. Please write your final response now.]'

// ── Implementation ────────────────────────────────────────────────────────────

export class EmptyResponseCapability<TState extends GraphState = GraphState>
    implements ICapability<TState>
{
    readonly id: string
    readonly lifecycle: ICapabilityLifecycle<TState>

    constructor(config: EmptyResponseCapabilityConfig<TState>, id = 'empty-response') {
        this.id = id

        const maxRetries   = config.maxRetries   ?? 2
        const recentWindow = config.recentWindow ?? 6
        const nudgeMidRun  = config.nudgeMidRun  ?? DEFAULT_NUDGE_MID_RUN
        const nudgeFinal   = config.nudgeFinal   ?? DEFAULT_NUDGE_FINAL

        this.lifecycle = {
            afterTurn: async (state: TState, turn: TurnRecord): Promise<void> => {
                const s = state as Record<string, unknown>
                const { content, toolCalls } = turn.modelResponse
                const isEmpty = !content?.trim() && (!toolCalls || toolCalls.length === 0)

                if (!isEmpty) {
                    s[config.emptyCountKey] = 0
                    return
                }

                const count = Number(s[config.emptyCountKey] ?? 0) + 1
                s[config.emptyCountKey] = count

                if (count > maxRetries) {
                    if (config.doneKey) {
                        s[config.doneKey] = true
                    }
                    return
                }

                // Select nudge based on recent history
                const messages  = s[config.messagesKey]
                const recent    = Array.isArray(messages) ? messages.slice(-recentWindow) : []
                const midRun    = recent.some(
                    (m: unknown) => (m as Record<string, unknown>)['role'] === 'tool_result',
                )
                const nudgeText = midRun ? nudgeMidRun : nudgeFinal

                const nudge: UserMessage = { role: 'user', content: nudgeText, sticky: true }
                if (Array.isArray(messages)) {
                    messages.push(nudge)
                }
            },
        }
    }
}
