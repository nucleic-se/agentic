import { expect, it } from 'vitest';
import { runRetentionEvaluation } from './retention.js';

it('repeats the same paired workload and distinguishes recovery from unavailable evidence', async () => {
    const first = await runRetentionEvaluation();
    expect(first.passed).toBe(true);
    expect(await runRetentionEvaluation()).toEqual(first);
    const roomy = first.cases.find(test => test.id === 'full-20000')!;
    const retained = first.cases.find(test => test.id === 'recoverable-20000')!;
    expect(retained.preparedEstimatedTokens).toBeLessThan(roomy.preparedEstimatedTokens);
    expect(retained.answerAvailable).toBe(true);
    expect(retained.retrievals).toBeGreaterThan(0);
    expect(first.cases.find(test => test.id === 'recoverable-2400')?.answerAvailable).toBe(true);
    expect(first.cases.find(test => test.id === 'no-grant-2400')?.references).toBe(0);
});
