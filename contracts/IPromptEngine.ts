/**
 * Prompt composition contracts.
 *
 * Domain-agnostic prompt assembly with priority scoring,
 * sticky sections, deterministic tie-breaking, and token budgeting.
 */

import type { ITokenCounter } from './ITokenCounter.js';
import type { MessageProvenance } from './llm.js';

export type PromptSectionTag = string;
/** Expected lifetime, not priority, protection, or a cache guarantee. */
export type ContextStability = 'stable' | 'retained' | 'transient';

export interface SystemSectionRange {
    /** Absent for the base system instructions. */
    id?: string;
    stability: ContextStability;
    /** Half-open UTF-16 offsets into the final system string, excluding separators. */
    start: number;
    end: number;
}

/**
 * Structural position in the assembled prompt.
 * Within each stability group, sections are grouped by phase (in the order below),
 * then ordered by ID for stable sections or score for other sections.
 */
export type PromptSectionPhase =
    | 'constraint'    // system rules, safety — first within stability group, always sticky
    | 'task'          // current objective framing
    | 'memory'        // retrieved memory items
    | 'tools'         // tool catalog / available actions
    | 'history'       // conversation or event history
    | 'user';         // current user message — always last

export interface PromptSection {
    /** Unique section identifier */
    id: string;
    /** Rendering group: stable first, retained (default), then transient. */
    stability?: ContextStability;

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
     * Sections are grouped by stability, then phase (in the order above).
     * Stable sections use ID ordering within a phase; other sections rank by score.
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
     * Selection is global by priority; stability and phase control rendering only.
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
