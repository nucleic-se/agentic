/**
 * Prompt composition contracts.
 *
 * Domain-agnostic prompt assembly with priority scoring,
 * sticky sections, deterministic tie-breaking, and token budgeting.
 */

import type { ITokenCounter } from './ITokenCounter.js';
import type { MessageProvenance } from './llm.js';

export type PromptSectionTag = string;

/**
 * Structural position in the assembled prompt.
 * Sections are grouped by phase (in the order below),
 * then ranked by score within each phase.
 */
export type PromptSectionPhase =
    | 'constraint'    // system rules, safety — always first, always sticky
    | 'task'          // current objective framing
    | 'memory'        // retrieved memory items
    | 'tools'         // tool catalog / available actions
    | 'history'       // conversation or event history
    | 'user';         // current user message — always last

export interface PromptSection {
    /** Unique section identifier */
    id: string;

    /** Attribution survives context selection and compression. */
    provenance?: MessageProvenance;

    /** Base importance (higher = more likely to survive trimming) */
    priority: number;

    /** @deprecated Calculate one priority externally. Defaults to 1. */
    weight?: number;

    /** @deprecated Composition counts the rendered text; this hint is ignored. */
    estimatedTokens?: number;

    /** Produces the text for this section */
    text(): string;

    /** Classification tags for filtering/grouping */
    tags?: PromptSectionTag[];

    /** If true, section is never trimmed */
    sticky?: boolean;

    /**
     * Dynamic per-section, per-context multiplier (e.g. recency, relevance).
     * Defaults to 1.0 when omitted.
     */
    contextMultiplier?: number;

    /**
     * Structural position in the assembled prompt.
     * Sections are grouped by phase (in the order above),
     * then ranked by score within each phase.
     * Defaults to 'task' when omitted for backward compatibility.
     */
    phase?: PromptSectionPhase;
}

export interface PromptComposeResult {
    /** Final ordered prompt text */
    text: string;

    /** Sections included in the final prompt */
    included: PromptSection[];

    /** Sections excluded by trimming */
    excluded: PromptSection[];

    /** Total estimated tokens used */
    totalTokens: number;
}

/**
 * Options for a single compose() call.
 */
export interface PromptComposeOptions {
    /** Counts rendered system content, including separators and message overhead. */
    tokenCounter?: ITokenCounter;
    /**
     * Called for each section dropped due to budget exhaustion.
     * Useful for triggering compaction, logging, or reactive memory management.
     */
    onDrop?: (section: PromptSection) => void;
}

export interface IPromptEngine {
    /**
     * Compose a prompt from sections within a token budget.
     *
     * Scoring: one priority; deprecated weight fields are normalized for compatibility
     * Sticky and constraint sections are required; an oversized required set throws.
     * Non-sticky sections are ranked by score desc, then stable id.
     * Selection is global by priority; phase controls rendering only.
     * Dropped sections are passed to options.onDrop if provided.
     */
    compose(sections: PromptSection[], tokenBudget: number, options?: PromptComposeOptions): PromptComposeResult;
}

/**
 * Open-ended context bag passed to prompt contributors.
 * Domains extend this with their own fields (e.g. actorId, agentId).
 */
export interface PromptContributionContext {
    [key: string]: unknown;
}

export interface IPromptContributor<TContext extends PromptContributionContext = PromptContributionContext> {
    /** Unique contributor identifier */
    id: string;

    /** Produce sections for the prompt engine */
    contribute(context: TContext): PromptSection[] | Promise<PromptSection[]>;
}

export interface IPromptContributorRegistry<TContext extends PromptContributionContext = PromptContributionContext> {
    register(contributor: IPromptContributor<TContext>): void;
    list(): IPromptContributor<TContext>[];
    resolve(id: string): IPromptContributor<TContext> | null;
}
