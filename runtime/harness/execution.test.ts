import { expect, it, vi } from 'vitest';
import { createHarnessExecution } from './execution.js';
import type { Message, TurnRequest } from '../../contracts/llm.js';

function fixture() {
    const assemble = vi.fn(async (messages: Message[]) => ({ messages, system: 'selected' }));
    const turn = vi.fn(async (_request: TurnRequest) => ({ message: { role: 'assistant' as const, content: 'done' }, stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } }));
    const execution = createHarnessExecution({ context: { assemble }, provider: { turn, structured: async () => { throw new Error('unused'); } } });
    return { execution, assemble, turn };
}
it('inspects a prepared request without dispatch, then executes that snapshot without rebuilding context', async () => {
    const { execution, assemble, turn } = fixture();
    const source: TurnRequest = { messages: [{ role: 'user', content: 'original' }] };
    const prepared = await execution.prepareModel(source);
    expect(turn).not.toHaveBeenCalled();
    source.messages[0].content = 'later source change';
    await execution.dispatchModel(prepared, { onPrepared: () => { prepared.request.messages[0].content = 'observer change'; } });
    expect(assemble).toHaveBeenCalledTimes(1);
    expect(turn.mock.calls[0][0].messages[0].content).toBe('original');
    expect(turn.mock.calls[0][0].system).toBe('selected');
});
it('respects cancellation between preparation and dispatch', async () => {
    const { execution, turn } = fixture();
    const prepared = await execution.prepareModel({ messages: [{ role: 'user', content: 'original' }] });
    const controller = new AbortController();
    controller.abort(new Error('cancelled before admission'));
    await expect(execution.dispatchModel(prepared, { signal: controller.signal })).rejects.toThrow('cancelled before admission');
    expect(turn).not.toHaveBeenCalled();
});

it('rejects an independently constructed request before dispatch', async () => {
    const { execution, turn } = fixture();
    await expect(execution.dispatchModel({ request: { messages: [], maxTokens: -1 } })).rejects.toThrow('was not prepared');
    expect(turn).not.toHaveBeenCalled();
});

it('rejects an invalid or exceeded reported ceiling before model dispatch', async () => {
    const { turn } = fixture();
    for (const tokenBudget of [0, NaN, 2]) {
        const execution = createHarnessExecution({ provider: { turn, structured: async () => { throw new Error('unused'); } },
            context: { assemble: async messages => ({ messages, report: { tokenBudget, decisions: [], usage: {
                systemTokens: 0, messageTokens: 3, toolTokens: 0, schemaTokens: 0, reservedOutputTokens: 0, totalTokens: 3,
            } } }) } });
        await expect(execution.model({ messages: [{ role: 'user', content: 'task' }] })).rejects.toThrow('inconsistent token accounting');
    }
    expect(turn).not.toHaveBeenCalled();
});

it('binds accounting and dispatch to the same snapshot despite edits to inspection copies', async () => {
    const { execution, turn } = fixture();
    const prepared = await execution.prepareModel({ messages: [{ role: 'user', content: 'small' }] });
    prepared.request.messages[0].content = 'x'.repeat(100000);
    expect(prepared.request.messages[0].content).toBe('small');
    await execution.dispatchModel(prepared);
    expect(turn.mock.calls[0][0].messages[0].content).toBe('small');
    await expect(fixture().execution.dispatchModel(prepared)).rejects.toThrow('different execution');
});

it('requires lossless source preparation when requested', async () => {
    const { execution, assemble, turn } = fixture();
    assemble.mockImplementation(async () => ({ messages: [], system: 'selected' }));
    await expect(execution.prepareModel({ messages: [{ role: 'user', content: 'source' }] }, { preserveMessages: true })).rejects.toThrow('protected source');
    expect(turn).not.toHaveBeenCalled();
});

it.each([
    { original: -1, retained: 3 },
    { original: 3, retained: NaN },
    { original: 3, retained: 2 },
])('rejects inconsistent group accounting before dispatch (%j)', async tokens => {
    const { turn } = fixture();
    const execution = createHarnessExecution({ provider: { turn, structured: async () => { throw new Error('unused'); } },
        context: { assemble: async messages => ({ messages, report: { decisions: [
            { kind: 'messages', id: 'group', protected: true, score: 0, action: 'kept', tokens },
        ], usage: { systemTokens: 0, messageTokens: 3, toolTokens: 0, schemaTokens: 0, reservedOutputTokens: 0, totalTokens: 3 } } }) } });
    await expect(execution.model({ messages: [{ role: 'user', content: 'task' }] })).rejects.toThrow('group token accounting');
    expect(turn).not.toHaveBeenCalled();
});

it('allows alternative strategies to omit group estimates without inventing zero cost', async () => {
    const { turn } = fixture();
    const execution = createHarnessExecution({ provider: { turn, structured: async () => { throw new Error('unused'); } },
        context: { assemble: async messages => ({ messages, report: { decisions: [
            { kind: 'messages', id: 'group', protected: true, score: 0, action: 'kept' },
        ], usage: { systemTokens: 0, messageTokens: 3, toolTokens: 0, schemaTokens: 0, reservedOutputTokens: 0, totalTokens: 3 } } }) } });
    const prepared = await execution.prepareModel({ messages: [{ role: 'user', content: 'task' }] });
    expect(prepared.report!.decisions[0].tokens).toBeUndefined();
    await execution.dispatchModel(prepared);
    expect(turn).toHaveBeenCalledTimes(1);
});
