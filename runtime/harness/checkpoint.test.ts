import { expect, it } from 'vitest';
import { checkpointView, checkpointBoundary, checkpointRequest } from './checkpoint.js';
import { composeAgentContext } from '../ContextPipeline.js';
import type { Message } from '../../contracts/llm.js';

it('keeps original history and the current instruction when its source is checkpointed', () => {
    const history: Message[] = [{ role: 'user', content: 'corrected task', provenance: 'human' }, { role: 'assistant', content: 'completed step' }, { role: 'user', content: 'wake', provenance: 'deterministic' }];
    const original = structuredClone(history);
    const view = checkpointView(history, { through: 2, text: 'step completed' }, [{ role: 'user', provenance: 'deterministic', content: 'runtime state' }]);
    expect(view.sourceIndexes).toEqual([null, 0, 2, null]);
    expect(view.sourceIndexes).toHaveLength(view.messages.length);
    expect(view.messages[1]).toEqual(history[0]);
    view.messages[1].content = 'changed view';
    expect(history).toEqual(original);
    expect(() => checkpointView(history, { through: 4, text: 'invalid' })).toThrow('boundary');
});
it('checkpoints a whole tool-call group and supplies original source evidence', async () => {
    const history: Message[] = [{ role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read', args: {} }] }, { role: 'tool_result', toolCallId: 'a', content: 'evidence '.repeat(1000) }, { role: 'user', content: 'finish', provenance: 'human' }];
    const view = checkpointView(history);
    const selected = await composeAgentContext({ messages: view.messages, tokenBudget: 100 }, { minRecentGroups: 1, compressMessage: () => null });
    const boundary = checkpointBoundary(view, selected);
    expect(boundary).toBe(2);
    const request = checkpointRequest(history, boundary!);
    expect(JSON.parse(request.messages[0].content).sources[1].content).toBe(history[1].content);
    expect(checkpointView(history, { through: boundary!, text: 'read completed' }).sourceIndexes).toEqual([null, 2]);
    expect(() => checkpointRequest(history, 2, { through: 2, text: 'already included' })).toThrow('advance');
    expect(() => checkpointRequest(history, 2, { through: -1, text: 'invalid' })).toThrow('boundary');
    expect(() => checkpointRequest(history, 2, { through: 0, text: '  ' })).toThrow('empty');
});

it('prepares the largest whole prefix that fits without dispatching maintenance probes', async () => {
    const { prepareCheckpoint } = await import('./checkpoint.js');
    const { createHarnessExecution } = await import('./execution.js');
    const { ContextBudgetExceededError } = await import('../PromptEngine.js');
    const history: Message[] = Array.from({ length: 4 }, () => ({ role: 'assistant', content: 'x'.repeat(1000) }));
    const view = checkpointView(history);
    const report = await composeAgentContext({ messages: view.messages, tokenBudget: 900 }, { minRecentGroups: 1 });
    expect(checkpointBoundary(view, report)).toBeLessThan(3);
    let dispatched = false;
    const execution = createHarnessExecution({
        context: { assemble: async messages => {
            const count = JSON.parse(messages[0].content).sources.length;
            if (count > 3) throw new ContextBudgetExceededError(3, count);
            return { messages };
        } },
        provider: { turn: async () => { dispatched = true; throw new Error('unexpected dispatch'); }, structured: async () => { throw new Error('unused'); } },
    });
    const selected = await prepareCheckpoint(execution, history, view, report, { maxTokens: 100 });
    expect(selected?.through).toBe(3);
    expect(JSON.parse(selected!.prepared.request.messages[0].content).sources).toHaveLength(3);
    expect(dispatched).toBe(false);
});

it('makes resumable progress through an oversized group without dropping or splitting active tool messages', async () => {
    const { createHarnessExecution } = await import('./execution.js');
    const { budgetedContext } = await import('./defaults.js');
    const { prepareCheckpoint } = await import('./checkpoint.js');
    const history: Message[] = [
        { role: 'assistant', content: 'Earlier work' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'large', name: 'read', args: {} }] },
        { role: 'tool_result', toolCallId: 'large', content: 'evidence🙂'.repeat(13000) },
        { role: 'user', content: 'Finish the task' },
    ];
    const original = structuredClone(history);
    const execution = createHarnessExecution({ context: budgetedContext('', 2000, { minRecentGroups: 1, compressMessage: () => null }),
        provider: { turn: async () => { throw new Error('No dispatch while fitting'); }, structured: async () => { throw new Error('unused'); } } });
    let previous: import('./checkpoint.js').WorkingCheckpoint = { through: 1, text: 'Earlier work completed.' };
    let recovered = '', chunks = 0;
    while (previous.through < 3) {
        const view = checkpointView(history, previous);
        expect(view.messages.some(m => m.role === 'assistant' && m.toolCalls?.[0].id === 'large')).toBe(true);
        expect(view.messages.some(m => m.role === 'tool_result' && m.toolCallId === 'large')).toBe(true);
        const task = await execution.prepareModel({ messages: view.messages, maxTokens: 100 });
        const selected = await prepareCheckpoint(execution, history, view, task.report!, { previous, maxTokens: 100 });
        expect(selected).toBeDefined();
        const chunk = JSON.parse(selected!.prepared.request.messages[0].content).sourceChunk;
        expect(chunk.offset).toBe(recovered.length);
        expect(chunk.endOffset).toBeGreaterThan(chunk.offset);
        recovered += chunk.text;
        expect(selected!.sourceRange.endOffset).toBe(recovered.length);
        expect(selected!.prepared.report!.usage.totalTokens).toBeLessThanOrEqual(2000);
        previous = structuredClone({ through: selected!.through, text: 'Evidence covered so far.', ...(selected!.partial ? { partial: selected!.partial } : {}) });
        if (++chunks > 100) throw new Error('No bounded checkpoint progress');
    }
    expect(chunks).toBeGreaterThan(1);
    expect(previous.partial).toBeUndefined();
    expect(recovered).toBe(JSON.stringify(history.slice(1, 3).map((message, offset) => ({ index: offset + 1, ...message }))));
    expect(history).toEqual(original);
});

it('does not advance coverage through evidence removed by a custom context strategy', async () => {
    const { createHarnessExecution } = await import('./execution.js');
    const { prepareCheckpoint } = await import('./checkpoint.js');
    const history: Message[] = Array.from({ length: 4 }, () => ({ role: 'assistant', content: 'x'.repeat(1000) }));
    const view = checkpointView(history);
    const report = await composeAgentContext({ messages: view.messages, tokenBudget: 900 }, { minRecentGroups: 1 });
    const execution = createHarnessExecution({ context: { assemble: async () => ({ messages: [] }) },
        provider: { turn: async () => { throw new Error('unexpected dispatch'); }, structured: async () => { throw new Error('unused'); } } });
    await expect(prepareCheckpoint(execution, history, view, report, { maxTokens: 100 })).rejects.toThrow('protected source');
});

it('distinguishes protected-input overflow without silently weakening retention', async () => {
    await expect(composeAgentContext({ messages: [{ role: 'user', content: 'instruction '.repeat(1000), sticky: true }], tokenBudget: 100 }))
        .rejects.toMatchObject({ reason: 'protected', budget: 100 });
});
