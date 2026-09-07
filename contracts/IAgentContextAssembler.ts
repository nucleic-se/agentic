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

import type { Message, ToolDefinition } from './llm.js'
import type { PromptSection, SystemSectionRange } from './IPromptEngine.js'

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
     * Estimated complete context ceiling: system + messages + tool schemas
     * + reserved output. A tokenizer-specific counter improves accuracy.
     */
    tokenBudget: number

    /** Override the assembler's configured instructions for this request. */
    system?: string
    /** Already contributed sections, selected alongside conversation groups. */
    sections?: readonly PromptSection[]
    /** The actual tool manifest sent with this model request. Never trimmed. */
    tools?: readonly ToolDefinition[]
    /** Output capacity withheld from the total ceiling. Defaults to zero. */
    reservedOutputTokens?: number
    signal?: AbortSignal
}

// ── Output ────────────────────────────────────────────────────────────────────

export interface AgentContextOutput {
    /** Accounting and selection decisions for exactly this prepared context. */
    report?: ContextReport;
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

export interface ContextTokenUsage {
    systemTokens: number;
    messageTokens: number;
    toolTokens: number;
    schemaTokens: number;
    reservedOutputTokens: number;
    totalTokens: number;
}
export interface ContextDecision {
    kind: 'section' | 'messages';
    /** Half-open indexes into the input message array for a complete conversation group. */
    messageRange?: { start: number; end: number };
    id: string;
    action: 'kept' | 'compressed' | 'dropped';
    /** Why this group or section was changed; omitted when kept. */
    reason?: 'budget' | 'presentation';
    score: number;
    protected: boolean;
    references?: Array<{ messageIndex: number; reference: string; originalCharacters: number; retainedCharacters: number }>;
}

export interface ContextReport {
    usage: ContextTokenUsage;
    decisions: ContextDecision[];
    /** Exact selected system-section boundaries after rendering and compression. */
    systemSections?: SystemSectionRange[];
}
