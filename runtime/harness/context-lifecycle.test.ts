import { expect, it } from 'vitest';
import { checkpointContextLifecycle, referenceContextLifecycle, type ContextMaintenance } from './context-lifecycle.js';
import { createHarnessExecution } from './execution.js';
import { budgetedContext } from './defaults.js';
import type { Message, TurnResponse } from '../../contracts/llm.js';

const response = (content: string): TurnResponse => ({ message: { role: 'assistant', content }, stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } });
function fixture() {
    const history: Message[] = [{ role: 'user', content: 'Do not release until verification passes.' },
        ...Array.from({ length: 40 }, (_, index) => ({ role: 'assistant' as const, content: `Observation ${index}: ${'evidence '.repeat(28)}` })),
        { role: 'user', content: 'Correction: security verification is also required.' }];
    const execution = createHarnessExecution({ context: budgetedContext('', 3000), provider: {
        turn: async () => { throw new Error('Lifecycle must not dispatch'); }, structured: async () => { throw new Error('unused'); },
    } });
    return { history, execution, request: { messages: history, maxTokens: 64, cacheScope: 'session' } };
}
it('swaps checkpoint maintenance for direct source selection using the same preparation boundary', async () => {
    const { request, execution, history } = fixture();
    const original = structuredClone(history);
    const checkpoint = await checkpointContextLifecycle({ maxTokens: 64, triggerRatio: 0.8 }).prepare({ request }, execution);
    expect(checkpoint.kind).toBe('maintenance');
    const direct = await referenceContextLifecycle().prepare({ request }, execution);
    expect(direct.kind).toBe('task');
    expect(direct.prepared.request.messages.filter(m => m.role === 'user')).toEqual(history.filter(m => m.role === 'user'));
    expect(direct.prepared.report!.usage.totalTokens).toBeLessThanOrEqual(3000);
    expect(history).toEqual(original);
});
it('resumes exact rejected candidate repair from serialized state before trying task preparation', async () => {
    const { request, execution } = fixture();
    const lifecycle = checkpointContextLifecycle({ maxTokens: 64, triggerRatio: 0.8 });
    const first = await lifecycle.prepare({ request }, execution) as ContextMaintenance;
    expect(first.kind).toBe('maintenance');
    const rejected = first.reduce(response('x'.repeat(8591)));
    expect(rejected.decision).toEqual({ accepted: false, reason: 'too_large', attempt: 1 });
    const state = JSON.parse(JSON.stringify(rejected.state));
    const repaired = await lifecycle.prepare({ request, state }, {
        prepareModel: (request, options) => {
            expect(request.system).toMatch(/^Repair/);
            expect(JSON.parse(request.messages[0].content).draft).toBe('x'.repeat(8591));
            return execution.prepareModel(request, options);
        },
    }) as ContextMaintenance;
    expect(repaired.kind).toBe('maintenance');
    const accepted = repaired.reduce(response('Verification and security checks remain unfinished.'));
    expect(accepted.decision).toEqual({ accepted: true });
    expect(accepted.state).not.toHaveProperty('rejected');
    expect(repaired.reduce(response('still too large '.repeat(1000)))).toMatchObject({
        error: 'Checkpoint rejected after two attempts: too_large', decision: { accepted: false, attempt: 2 },
    });
    expect(state).toEqual(rejected.state);
});
it('keeps transient host facts outside source coverage and preserves their task presentation', async () => {
    const { request, execution } = fixture();
    const suffix: Message[] = [{ role: 'user', provenance: 'deterministic', sticky: true, content: 'Remaining calls: 7' }];
    const lifecycle = checkpointContextLifecycle({ maxTokens: 64, triggerRatio: 0.8 });
    const step = await lifecycle.prepare({ request, suffix }, execution) as ContextMaintenance;
    const evidence = JSON.parse(step.prepared.request.messages[0].content);
    expect(JSON.stringify(evidence)).not.toContain('Remaining calls');
    const direct = await referenceContextLifecycle().prepare({ request, suffix }, execution);
    expect(direct.prepared.request.messages.at(-1)?.content).toBe('Remaining calls: 7');
});
