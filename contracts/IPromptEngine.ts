/**
 * Prompt composition contracts.
 *
 * Domain-agnostic prompt assembly with priority×weight scoring,
 * sticky sections, deterministic tie-breaking, and token budgeting.
 */

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

    /** Base importance (higher = more likely to survive trimming) */
    priority: number;

    /** Scenario/profile multiplier applied to priority */
    weight: number;

    /** Estimated token cost of the rendered text */
    estimatedTokens: number;

    /** Produces the text for this section */
    text(): string;

    /** Classification tags for filtering/grouping */
    tags: PromptSectionTag[];

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

export interface IPromptEngine {
    /**
     * Compose a prompt from sections within a token budget.
     *
     * Scoring: score = priority * weight * contextMultiplier
     * Sticky sections are always included.
     * Non-sticky sections are ranked by score desc, then stable id.
     * Sections are included until budget is reached.
     */
    compose(sections: PromptSection[], tokenBudget: number): PromptComposeResult;
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
