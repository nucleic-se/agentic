/**
 * Agent context assembler contract.
 *
 * Separates context selection from rendering. Given the current conversation
 * and a token budget, the assembler decides what the model should see this turn:
 *
 *   system   — assembled via IPromptEngine; may include summaries, facts,
 *              structural context, and base instructions
 *   messages — the selected conversation sequence; typically a tail of the
 *              raw history, not the full array
 *
 * This is distinct from IContextAssembler, which operates at the lower level
 * of combining prompt sections and tool results. IAgentContextAssembler owns
 * the full model-facing context decision for one agent turn.
 *
 * Design principles:
 *
 *   - The input carries the full raw conversation; the assembler decides
 *     how much of it to include in output.messages.
 *
 *   - output.messages is what gets passed to TurnRequest.messages. It is
 *     NOT the full conversation array. This is the seam that makes context
 *     selection real rather than cosmetic.
 *
 *   - output.system is what gets passed to TurnRequest.system. Historical
 *     context that does not fit as raw messages (summaries, facts, file
 *     footprint) should be rendered here.
 *
 *   - Implementations are free to call IPromptEngine, IMemoryStore, or any
 *     other primitive. The contract is defined by inputs and outputs only.
 *
 * @module contracts
 */

import type { Message } from './llm.js'

// ── Input ─────────────────────────────────────────────────────────────────────

export interface AgentContextInput {
    /**
     * The current user input or continuation context. Used for relevance
     * scoring of history and fact retrieval.
     */
    userInput: string

    /**
     * The full raw conversation history. The assembler decides how much
     * to include in the output. Pass the complete array; do not pre-trim.
     */
    messages: Message[]

    /**
     * Token budget for the assembled context (system + messages combined).
     * The assembler must stay within this budget.
     */
    tokenBudget: number
}

// ── Output ────────────────────────────────────────────────────────────────────

export interface AgentContextOutput {
    /**
     * The assembled system string. Pass directly to TurnRequest.system.
     * Contains structured context: base prompt, summaries, facts, metadata.
     * May be empty string if no system content was assembled.
     */
    system: string

    /**
     * The selected message sequence. Pass directly to TurnRequest.messages.
     * This is a subset (or transformation) of the input messages — not the
     * full raw history. Older turns are compressed or dropped by the assembler.
     */
    messages: Message[]
}

// ── Contract ──────────────────────────────────────────────────────────────────

export interface IAgentContextAssembler {
    /**
     * Assemble the model-facing context for one agent turn.
     *
     * The returned system and messages together represent everything the
     * model will see. The caller passes them directly to TurnRequest.
     */
    assemble(input: AgentContextInput): Promise<AgentContextOutput>
}
