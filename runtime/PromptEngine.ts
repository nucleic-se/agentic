/**
 * Prompt engine runtime.
 *
 * Generic prompt composition with priority*weight scoring,
 * sticky sections, deterministic tie-breaking, and token budgeting.
 */

import type { IPromptEngine, PromptSection, PromptComposeResult } from '../contracts/index.js';

export class PromptEngine implements IPromptEngine {
    compose(sections: PromptSection[], tokenBudget: number): PromptComposeResult {
        if (sections.length === 0) {
            return { text: '', included: [], excluded: [], totalTokens: 0 };
        }

        const sticky = sections.filter(s => s.sticky);
        const nonSticky = sections.filter(s => !s.sticky);

        // Score: priority * weight * contextMultiplier. Deterministic tie-break by id.
        const scored = nonSticky
            .map(s => ({ section: s, score: s.priority * s.weight * (s.contextMultiplier ?? 1) }))
            .sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                return a.section.id.localeCompare(b.section.id);
            });

        const included: PromptSection[] = [];
        const excluded: PromptSection[] = [];
        let totalTokens = 0;

        // Sticky sections always included first
        for (const s of sticky) {
            included.push(s);
            totalTokens += s.estimatedTokens;
        }

        // Add non-sticky by score until budget exhausted
        for (const { section } of scored) {
            const nextTokens = totalTokens + section.estimatedTokens;
            if (nextTokens > tokenBudget && included.length > 0) {
                excluded.push(section);
                continue;
            }
            included.push(section);
            totalTokens = nextTokens;
        }

        const text = included.map(s => s.text()).join('\n\n');

        return { text, included, excluded, totalTokens };
    }
}
