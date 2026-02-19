/**
 * Context assembly pipeline contract.
 *
 * Orchestrates the composition of prompt sections from contributors
 * and tool results into a final prompt, enforcing phase ordering
 * and trust-tier labeling.
 *
 * @module contracts
 */

import type { PromptSection, PromptComposeResult } from './IPromptEngine.js';
import type { ToolResult } from './ITool.js';

export interface AssemblyInput {
    /** Sections contributed by registered contributors. */
    contributorSections: PromptSection[];
    /** Raw tool results — rendered by IToolPromptRenderer before assembly. */
    toolResults?: ToolResult[];
    /** Token budget for the assembled prompt. */
    tokenBudget: number;
}

export interface IContextAssembler {
    /**
     * Assemble a prompt from contributor sections and tool results.
     * Enforces phase ordering; tool results rendered with trust-tier labeling.
     */
    assemble(input: AssemblyInput): PromptComposeResult;
}
