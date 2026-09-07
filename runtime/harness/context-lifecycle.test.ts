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
    const rejected = first.reduce({ ...response('x'.repeat(8591)), stopReason: 'max_tokens' });
    expect(rejected.decision).toEqual({ accepted: false, reason: 'incomplete', attempt: 1 });
    const state = JSON.parse(JSON.stringify(rejected.state));
    const repaired = await lifecycle.prepare({ request, state }, {
        prepareModel: (request, options) => {
            expect(request.system).toMatch(/^Repair/);
            const evidence = JSON.parse(request.messages[0].content);
            expect(evidence.draft).toBe('x'.repeat(8591));
            expect(evidence.requirements).toEqual([
                { index: 0, content: 'Do not release until verification passes.' },
                { index: 41, content: 'Correction: security verification is also required.' },
            ]);
            return execution.prepareModel(request, options);
        },
    }) as ContextMaintenance;
    expect(repaired.kind).toBe('maintenance');
    const accepted = repaired.reduce(response('Verification and security checks remain unfinished.'));
    expect(accepted.decision).toEqual({ pending: true, attempt: 2 });
    expect(accepted.state).not.toHaveProperty('rejected');
    expect(repaired.reduce({ ...response('still incomplete'), stopReason: 'max_tokens' })).toMatchObject({
        error: 'Checkpoint rejected after two attempts: incomplete', decision: { accepted: false, attempt: 2 },
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


it('anchors later source chunks to original human requirements and corrections', async () => {
    const { request, execution } = fixture();
    request.messages.splice(1, 0, { role: 'user', provenance: 'model', content: 'Incorrect derived interpretation of the task.' });
    const lifecycle = checkpointContextLifecycle({ maxTokens: 64, triggerRatio: 0.8 });
    const step = await lifecycle.prepare({ request, state: { kind: 'checkpoint', checkpoint: {
        through: 3, text: 'A previous summary with a different interpretation.', partial: { end: 10, offset: 1 },
    } } }, execution) as ContextMaintenance;
    const input = JSON.parse(step.prepared.request.messages[0].content);
    expect(input.requirements).toEqual([
        { index: 0, content: 'Do not release until verification passes.' },
        { index: 42, content: 'Correction: security verification is also required.' },
    ]);
    expect(input.sourceChunk.start).toBe(3);
    expect(input.sourceChunk.text).not.toContain('Do not release');
    expect(input.requirements.some((r: { content: string }) => r.content.includes('Incorrect derived'))).toBe(false);
});


it('admits a complete draft above the character target through real context preparation after serialization', async () => {
    const { request, execution, history } = fixture();
    const lifecycle = checkpointContextLifecycle({ maxTokens: 64, triggerRatio: 0.8 });
    const first = await lifecycle.prepare({ request }, execution) as ContextMaintenance;
    const pending = first.reduce(response('Evidence remains available. '.repeat(350)));
    expect(pending.decision).toEqual({ pending: true, attempt: 1 });
    expect(pending.state).not.toHaveProperty('rejected');
    const state = JSON.parse(JSON.stringify(pending.state));
    const original = structuredClone(history);
    const roomier = createHarnessExecution({ context: budgetedContext('', 16000), provider: {
        turn: async () => { throw new Error('Admission must not dispatch'); }, structured: async () => { throw new Error('unused'); },
    } });
    const step = await lifecycle.prepare({ request, state }, roomier);
    expect(step.kind).toBe('task');
    expect(step.prepared.report!.usage.totalTokens).toBeLessThanOrEqual(16000);
    expect(step.prepared.request.messages.find(m => m.content.startsWith('Working checkpoint'))!.content).toContain(state.candidate.text);
    const accepted = step.reduce!(response('done'));
    expect(accepted.decision).toEqual({ accepted: true });
    expect(accepted.state).toEqual({ kind: 'checkpoint', checkpoint: {
        through: state.candidate.through, text: state.candidate.text,
        ...(state.candidate.partial ? { partial: state.candidate.partial } : {}),
    } });
    expect(state).toEqual(pending.state);
    expect(history).toEqual(original);
});

it('repairs actual context overflow once and retains the last valid checkpoint across restart', async () => {
    const { request: base, execution } = fixture();
    // The task system consumes space that a tools-free maintenance request does not need.
    const request = { ...base, system: 'Task instruction. '.repeat(250) };
    const lifecycle = checkpointContextLifecycle({ maxTokens: 64, triggerRatio: 0.8 });
    const checkpoint = { through: 1, text: 'Previous verified evidence.' };
    const first = await lifecycle.prepare({ request, state: { kind: 'checkpoint', checkpoint } }, execution) as ContextMaintenance;
    const pending = first.reduce(response('x'.repeat(8591)));
    const state = JSON.parse(JSON.stringify(pending.state));
    expect(state.checkpoint).toEqual(checkpoint);
    const repair = await lifecycle.prepare({ request, state }, execution) as ContextMaintenance;
    expect(repair.kind).toBe('maintenance');
    expect(repair.prepared.request.system).toMatch(/^Repair/);
    expect(JSON.parse(repair.prepared.request.messages[0].content)).toMatchObject({
        rejectedDraft: 'too_large', draft: state.candidate.text, sourceRange: state.candidate.sourceRange,
    });
    expect(repair.metadata.rejection).toBe('too_large');
    const twice = repair.reduce(response('x'.repeat(8591)));
    expect(twice.decision).toEqual({ pending: true, attempt: 2 });
    const restored = JSON.parse(JSON.stringify(twice.state));
    expect(restored.checkpoint).toEqual(checkpoint);
    await expect(lifecycle.prepare({ request, state: restored }, execution)).rejects.toThrow('after two attempts: too_large');
    await expect(lifecycle.prepare({ request, state: restored }, execution)).rejects.toThrow('after two attempts: too_large');
    expect(restored).toEqual(twice.state);
    expect(state).toEqual(pending.state);
});

it('does not turn cancellation or preparation failures into checkpoint repair', async () => {
    const { request, execution } = fixture();
    const lifecycle = checkpointContextLifecycle({ maxTokens: 64, triggerRatio: 0.8 });
    const first = await lifecycle.prepare({ request }, execution) as ContextMaintenance;
    const pending = first.reduce(response('Complete candidate.'));
    const error = new Error('Preparation cancelled');
    await expect(lifecycle.prepare({ request, state: pending.state }, {
        prepareModel: async () => { throw error; },
    })).rejects.toBe(error);
});
