/**
 * Prompt engine runtime.
 *
 * Generic prompt composition with priority*weight scoring,
 * sticky sections, deterministic tie-breaking, and token budgeting.
 */

import type { IPromptEngine, PromptSection, PromptComposeResult, PromptSectionPhase } from '../contracts/index.js';

/** Canonical phase ordering — determines position in assembled prompt. */
const PHASE_ORDER: PromptSectionPhase[] = [
    'constraint',
    'task',
    'memory',
    'tools',
    'history',
    'user',
];

export class PromptEngine implements IPromptEngine {
    compose(sections: PromptSection[], tokenBudget: number): PromptComposeResult {
        if (sections.length === 0) {
            return { text: '', included: [], excluded: [], totalTokens: 0 };
        }

        // Pre-compute scores once — used in phase-group sorting and the final sort.
        const scoreMap = new Map<string, number>(
            sections.map(s => [s.id, s.priority * s.weight * (s.contextMultiplier ?? 1)]),
        );

        const sticky = sections.filter(s => s.sticky);
        const nonSticky = sections.filter(s => !s.sticky);

        // Group non-sticky sections by phase, then sort by score within each phase
        const phaseGroups = new Map<PromptSectionPhase, { section: PromptSection; score: number }[]>();
        for (const phase of PHASE_ORDER) {
            phaseGroups.set(phase, []);
        }

        for (const s of nonSticky) {
            const phase: PromptSectionPhase = s.phase ?? 'task';
            const score = scoreMap.get(s.id)!;
            const group = phaseGroups.get(phase);
            if (group) {
                group.push({ section: s, score });
            } else {
                // Unknown phase falls back to 'task'
                phaseGroups.get('task')!.push({ section: s, score });
            }
        }

        // Sort each phase group by score desc, then stable id tie-break
        for (const group of phaseGroups.values()) {
            group.sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                return a.section.id.localeCompare(b.section.id);
            });
        }

        // Flatten into ordered list: phases in canonical order, scored within each
        const ordered = PHASE_ORDER.flatMap(phase => phaseGroups.get(phase)!);

        const included: PromptSection[] = [];
        const excluded: PromptSection[] = [];
        let totalTokens = 0;

        // Sticky sections always included first
        for (const s of sticky) {
            included.push(s);
            totalTokens += s.estimatedTokens;
        }

        // Add non-sticky by phase order + score until budget exhausted
        for (const { section } of ordered) {
            const nextTokens = totalTokens + section.estimatedTokens;
            if (nextTokens > tokenBudget && included.length > 0) {
                excluded.push(section);
                continue;
            }
            included.push(section);
            totalTokens = nextTokens;
        }

        // Re-sort included sections for final text assembly:
        // sticky sections first, then by phase order, then by score within phase
        const stickySet = new Set(sticky.map(s => s.id));
        included.sort((a, b) => {
            const aSticky = stickySet.has(a.id) ? 1 : 0;
            const bSticky = stickySet.has(b.id) ? 1 : 0;
            // Sticky sections first
            if (aSticky !== bSticky) return bSticky - aSticky;
            // Normalize unknown phases to 'task' for stable ordering
            const normPhase = (p: string | undefined): PromptSectionPhase =>
                (p && PHASE_ORDER.includes(p as PromptSectionPhase)) ? p as PromptSectionPhase : 'task';
            const aPhase = PHASE_ORDER.indexOf(normPhase(a.phase));
            const bPhase = PHASE_ORDER.indexOf(normPhase(b.phase));
            if (aPhase !== bPhase) return aPhase - bPhase;
            // Then by score desc within phase
            const aScore = scoreMap.get(a.id) ?? 0;
            const bScore = scoreMap.get(b.id) ?? 0;
            if (bScore !== aScore) return bScore - aScore;
            return a.id.localeCompare(b.id);
        });

        const text = included.map(s => s.text()).join('\n\n');

        return { text, included, excluded, totalTokens };
    }
}
