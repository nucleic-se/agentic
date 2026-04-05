/**
 * EmptyResponseCapability — handles consecutive silent LLM turns gracefully.
 *
 * Two distinct silence patterns are handled:
 *
 * 1. Completely empty (no text, no tool calls) — the model said nothing at all.
 *    Nudges with nudgeMidRun / nudgeFinal based on recent history, then sets
 *    state[stopKey] after maxRetries consecutive occurrences.
 *
 * 2. Text-silent with tool calls — the model made tool calls but wrote no
 *    accompanying text. Common with models that silently chain tools without
 *    narrating reasoning steps, which breaks summarisation and planning nodes
 *    that read from text content.
 *    Enabled by setting requireTextWithToolUse: true (default: false for
 *    backward compatibility). Uses a separate counter (emptyCountKey + '_tool')
 *    so it does not interfere with the completely-empty counter.
 *    Nudges with nudgeToolOnly after each silent-tool turn.
 *
 * Both counters live in state, not on the capability instance, so concurrent
 * runs are independent and counts survive checkpoints.
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
     * State key to track consecutive completely-empty turn count.
     * Lives in state so concurrent runs are independent and count survives checkpoints.
     * Also used as the base key for the text-silent-with-tools counter
     * (stored as state[emptyCountKey + '_tool']).
     */
    emptyCountKey: keyof TState & string
    /**
     * State key to set to true when max retries are exceeded.
     * If omitted, the capability only nudges without setting a stop flag.
     */
    stopKey?: keyof TState & string
    /**
     * Deprecated alias for stopKey.
     * Retained temporarily for backwards compatibility.
     */
    doneKey?: keyof TState & string
    /**
     * Max consecutive completely-empty turns before giving up.
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
    /**
     * When true, also nudge turns where the model made tool calls but produced no text.
     * This is off by default for backward compatibility. Enable for models that silently
     * chain tool calls without narrating their reasoning.
     * Default: false.
     */
    requireTextWithToolUse?: boolean
    /**
     * Nudge injected when the model called tools without writing any text.
     * Only used when requireTextWithToolUse is true.
     */
    nudgeToolOnly?: string
}

const DEFAULT_NUDGE_MID_RUN =
    '[Your last response was empty. Please continue — use a tool call or write your next step.]'

const DEFAULT_NUDGE_FINAL =
    '[Your last response was empty. Please write your final response now.]'

const DEFAULT_NUDGE_TOOL_ONLY =
    '[You called a tool without writing anything. Before your next tool call, write one short sentence explaining what you are doing and why.]'

// ── Implementation ────────────────────────────────────────────────────────────

export class EmptyResponseCapability<TState extends GraphState = GraphState>
    implements ICapability<TState>
{
    readonly id: string
    readonly lifecycle: ICapabilityLifecycle<TState>

    constructor(config: EmptyResponseCapabilityConfig<TState>, id = 'empty-response') {
        this.id = id

        const maxRetries          = config.maxRetries          ?? 2
        const recentWindow        = config.recentWindow        ?? 6
        const nudgeMidRun         = config.nudgeMidRun         ?? DEFAULT_NUDGE_MID_RUN
        const nudgeFinal          = config.nudgeFinal          ?? DEFAULT_NUDGE_FINAL
        const requireTextWithTools = config.requireTextWithToolUse ?? false
        const nudgeToolOnly       = config.nudgeToolOnly       ?? DEFAULT_NUDGE_TOOL_ONLY
        const toolOnlyCountKey    = `${config.emptyCountKey}_tool`

        this.lifecycle = {
            afterTurn: async (state: TState, turn: TurnRecord): Promise<void> => {
                const s = state as Record<string, unknown>
                const { content, toolCalls } = turn.modelResponse
                const hasText  = !!content?.trim()
                const hasTools = !!(toolCalls && toolCalls.length > 0)

                // ── Case 1: completely empty (no text, no tool calls) ─────────
                const completelyEmpty = !hasText && !hasTools
                if (completelyEmpty) {
                    s[toolOnlyCountKey] = 0 // reset tool-only counter

                    const count = Number(s[config.emptyCountKey] ?? 0) + 1
                    s[config.emptyCountKey] = count

                    if (count > maxRetries) {
                        const stopKey = config.stopKey ?? config.doneKey
                        if (stopKey) {
                            s[stopKey] = true
                        }
                        return
                    }

                    const messages = s[config.messagesKey]
                    const recent   = Array.isArray(messages) ? messages.slice(-recentWindow) : []
                    const midRun   = recent.some(
                        (m: unknown) => (m as Record<string, unknown>)['role'] === 'tool_result',
                    )
                    const nudgeText = midRun ? nudgeMidRun : nudgeFinal
                    const nudge: UserMessage = { role: 'user', content: nudgeText, sticky: true }
                    if (Array.isArray(messages)) {
                        messages.push(nudge)
                    }
                    return
                }

                // ── Case 2: tool calls with no text (when opted in) ───────────
                if (requireTextWithTools && hasTools && !hasText) {
                    s[config.emptyCountKey] = 0 // reset completely-empty counter

                    const count = Number(s[toolOnlyCountKey] ?? 0) + 1
                    s[toolOnlyCountKey] = count

                    // Don't gate on maxRetries — nudge every silent-tool turn
                    // since each one is an independent planning failure.
                    const messages = s[config.messagesKey]
                    const nudge: UserMessage = { role: 'user', content: nudgeToolOnly, sticky: true }
                    if (Array.isArray(messages)) {
                        messages.push(nudge)
                    }
                    return
                }

                // ── Non-empty turn: reset both counters ───────────────────────
                s[config.emptyCountKey] = 0
                s[toolOnlyCountKey] = 0
            },
        }
    }
}
