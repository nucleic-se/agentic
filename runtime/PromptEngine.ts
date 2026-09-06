import type { IPromptEngine, PromptSection, PromptComposeResult, PromptComposeOptions, PromptSectionPhase } from '../contracts/IPromptEngine.js';
import { HeuristicTokenCounter } from './HeuristicTokenCounter.js';

export class ContextBudgetExceededError extends Error {
    constructor(readonly budget: number, readonly estimatedTokens: number) {
        super(`Context requires approximately ${estimatedTokens} tokens but the budget is ${budget}`);
        this.name = 'ContextBudgetExceededError';
    }
}
const phases: PromptSectionPhase[] = ['constraint', 'task', 'memory', 'tools', 'history', 'user'];
/** Legacy multipliers are normalized at the boundary; new callers supply priority only. */
export function sectionPriority(section: PromptSection): number {
    const priority = section.priority * (section.weight ?? 1) * (section.contextMultiplier ?? 1);
    if (!Number.isFinite(priority)) throw new RangeError(`Prompt section ${section.id} has a non-finite priority`);
    return priority;
}
export function sectionProtected(section: PromptSection): boolean {
    return !!section.sticky || section.phase === 'constraint';
}
export function snapshotPromptSection(section: PromptSection): PromptSection {
    sectionPriority(section);
    const text = section.text();
    if (typeof text !== 'string') throw new TypeError(`Prompt section ${section.id} did not render text`);
    return { ...section, tags: [...(section.tags ?? [])], text: () => text };
}
/** Placement is independent of protection and selection priority. */
export function renderPromptSections(sections: readonly PromptSection[]): { text: string; included: PromptSection[] } {
    const phase = (s: PromptSection) => (phases.includes(s.phase as PromptSectionPhase) ? phases.indexOf(s.phase!) : phases.indexOf('task'));
    const included = [...sections].sort((a, b) => phase(a) - phase(b) || sectionPriority(b) - sectionPriority(a) || a.id.localeCompare(b.id));
    return { text: included.map(s => s.text()).filter(Boolean).join('\n\n'), included };
}
/** Select globally by priority, then render by phase, charging the rendered system message. */
export function composePromptSections(sections: PromptSection[], tokenBudget: number, options: PromptComposeOptions = {}): PromptComposeResult {
    if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 0) throw new RangeError('tokenBudget must be a non-negative safe integer');
    const counter = options.tokenCounter ?? new HeuristicTokenCounter();
    const snapshot = sections.map(snapshotPromptSection);
    if (new Set(snapshot.map(s => s.id)).size !== snapshot.length) throw new Error('Duplicate prompt section');
    const cost = (items: PromptSection[]) => {
        const result = renderPromptSections(items);
        const estimate = result.text ? counter.countTokensForMessages([{ role: 'system', content: result.text }]) : 0;
        if (!Number.isFinite(estimate) || estimate < 0) throw new RangeError('Token counter must return a non-negative finite estimate');
        return { ...result, totalTokens: Math.ceil(estimate) };
    };
    const minimum = cost(snapshot.filter(sectionProtected));
    if (minimum.totalTokens > tokenBudget) throw new ContextBudgetExceededError(tokenBudget, minimum.totalTokens);
    let kept = [...snapshot];
    const excluded: PromptSection[] = [];
    let result = cost(kept);
    // Equal-priority sections retain stable identifier ordering regardless of contribution order.
    for (const item of snapshot.filter(s => !sectionProtected(s)).sort((a, b) => sectionPriority(a) - sectionPriority(b) || b.id.localeCompare(a.id))) {
        if (result.totalTokens <= tokenBudget) break;
        kept = kept.filter(s => s !== item);
        excluded.push(item);
        result = cost(kept);
    }
    for (const item of excluded) options.onDrop?.(item);
    return { ...result, excluded };
}
export class PromptEngine implements IPromptEngine {
    compose(sections: PromptSection[], tokenBudget: number, options?: PromptComposeOptions): PromptComposeResult {
        return composePromptSections(sections, tokenBudget, options);
    }
}
