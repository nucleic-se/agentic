import { describe, expect, it } from 'vitest';
import { composeAgentContext, estimateContextTokens } from '../ContextPipeline.js';
import { contextEvaluationCases, runContextEvaluation } from './context.js';

describe('deterministic context evaluation', () => {
    it('passes the long-context corpus with reproducible JSON-safe evidence metrics', async () => {
        const first = await runContextEvaluation();
        expect(first.cases.filter(item => !item.passed)).toEqual([]);
        expect(first.passed).toBe(true);
        expect(JSON.parse(JSON.stringify(first))).toEqual(first);
        expect(await runContextEvaluation()).toEqual(first);
        expect(first.cases.find(item => item.id === 'priority-over-recency-400')?.metrics.inputEstimatedTokens).toBeGreaterThan(50000);
        expect(first.cases.find(item => item.id === 'compression-retains-evidence')?.metrics.compressedItems).toBeGreaterThan(0);
        expect(first.cases.find(item => item.id === 'protected-overflow')?.checks.expectedOutcome).toBe(true);
    });
    it('fails an evidence-losing strategy even when its accounting remains correct', async () => {
        const report = await runContextEvaluation(contextEvaluationCases().slice(0, 1), async (input, options) => {
            const result = await composeAgentContext(input, options);
            result.system = result.system.replace('ACCESS_CODE=7421', 'ACCESS_CODE=unknown');
            result.usage = estimateContextTokens({ ...input, system: result.system, messages: result.messages }, options);
            return result;
        });
        expect(report.passed).toBe(false);
        expect(report.cases[0].checks.accounting).toBe(true);
        expect(report.cases[0].checks.evidence).toBe(false);
        expect(report.cases[0].checks.oracle).toBe(false);
    });
    it('fails partial tool groups, fake accounting and swallowed protected overflow', async () => {
        const toolCase = contextEvaluationCases().filter(item => item.id === 'long-tool-history');
        const broken = await runContextEvaluation(toolCase, async (input, options) => {
            const result = await composeAgentContext(input, options);
            result.messages = result.messages.filter(message => message.role !== 'tool_result');
            return result;
        });
        expect(broken.passed).toBe(false);
        expect(broken.cases[0].checks.toolIntegrity).toBe(false);
        expect(broken.cases[0].checks.accounting).toBe(false);
        const swallowed = await runContextEvaluation(contextEvaluationCases().filter(item => item.expectProtectedOverflow), async () => ({
            system: '', messages: [], includedSections: [], excludedSections: [], decisions: [],
            usage: estimateContextTokens({ system: '', messages: [] }),
        }));
        expect(swallowed.passed).toBe(false);
        expect(swallowed.cases[0].checks.expectedOutcome).toBe(false);
    });
    it('rejects empty or duplicate suites instead of producing a vacuous pass', async () => {
        await expect(runContextEvaluation([])).rejects.toThrow('at least one');
        const fixture = contextEvaluationCases()[0];
        await expect(runContextEvaluation([fixture, fixture])).rejects.toThrow('unique');
    });
});
