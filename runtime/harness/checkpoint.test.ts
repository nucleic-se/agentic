import { expect, it } from 'vitest';
import { checkpointView, checkpointBoundary, checkpointRequest } from './checkpoint.js';
import { composeAgentContext } from '../ContextPipeline.js';
import type { Message } from '../../contracts/llm.js';

it('retains pinned instructions across repeated checkpoints without duplicating the latest instruction', () => {
    const history: Message[] = [
        { role: 'user', content: 'Keep the source data unchanged', sticky: true },
        { role: 'assistant', content: 'Inspected the data' },
        { role: 'user', content: 'Report uncertainty explicitly', sticky: true, provenance: 'deterministic' },
        { role: 'assistant', content: 'Found conflicting records' },
        { role: 'user', content: 'Use the corrected date', sticky: true },
        { role: 'assistant', content: 'Verification remains unfinished' },
    ];
    const original = structuredClone(history);
    for (const through of [2, 4, 6]) {
        const view = checkpointView(history, { through, text: 'An intentionally incomplete summary' });
        const expected = history.map((_, index) => index).filter(index => index >= through || [0, 2, 4].includes(index));
        expect(view.sourceIndexes).toEqual([null, ...expected]);
        expect(view.messages.slice(1)).toEqual(expected.map(index => history[index]));
        view.messages[1].content = 'mutated inspection';
        expect(history).toEqual(original);
    }
});

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

it('retains unpinned human objectives and corrections across every checkpoint boundary', () => {
    const history: Message[] = [
        { role: 'user', content: 'Release after integration passes' },
        { role: 'assistant', content: 'Investigating' },
        { role: 'user', provenance: 'human', content: 'Correction: security verification must also pass' },
        { role: 'user', provenance: 'model', content: 'A speculative conclusion' },
        { role: 'user', content: 'Continue' },
    ];
    for (const through of [2, 4, 5]) {
        const view = checkpointView(history, { through, text: 'Incomplete working summary' });
        expect(view.messages.filter(message => message.role === 'user' && (message.provenance ?? 'human') === 'human'))
            .toEqual([history[0], history[2], history[4]]);
        expect(new Set(view.sourceIndexes.filter(index => index !== null)).size).toBe(view.sourceIndexes.length - 1);
    }
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
        { role: 'assistant', content: '', toolCalls: [{ id: 'large', name: 'read', args: {} }],
            continuation: { format: 'test/v1', identity: 'backend', contentHash: 'binding', data: 'opaque-protocol'.repeat(1000) } },
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
    expect(JSON.parse(recovered)).toEqual([
        { index: 1, role: 'assistant', content: '', toolCalls: [{ id: 'large', name: 'read', args: {} }] },
        { index: 2, ...history[2] },
    ]);
    expect(history).toEqual(original);
});

it('summarizes visible evidence while retaining native continuation in the archive and active view', () => {
    const history: Message[] = [
        { role: 'user', content: 'Check this evidence', provenance: 'human', sticky: true },
        { role: 'assistant', content: 'Observed a discrepancy', provenance: 'model',
            toolCalls: [{ id: 'read', name: 'read', args: { continuation: 'ordinary tool argument' } }],
            continuation: { format: 'test/v1', identity: 'backend', contentHash: 'binding', data: 'opaque protocol state' } },
        { role: 'tool_result', toolCallId: 'read', toolName: 'read', content: 'Exact source text', isError: true,
            contentBlocks: [{ type: 'text', text: 'Exact source text' }, { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }] },
    ];
    const original = structuredClone(history);
    const request = checkpointRequest(history, history.length);
    expect(JSON.parse(request.messages[0].content).sources).toEqual([
        { index: 0, ...history[0] },
        { index: 1, role: 'assistant', content: 'Observed a discrepancy', provenance: 'model',
            toolCalls: [{ id: 'read', name: 'read', args: { continuation: 'ordinary tool argument' } }] },
        { index: 2, ...history[2] },
    ]);
    expect(checkpointView(history).messages).toEqual(original);
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

it('checkpoints pressure-compressed history without waiting for eviction, retaining the recent tail', async () => {
    const { createHarnessExecution } = await import('./execution.js');
    const { budgetedContext } = await import('./defaults.js');
    const { prepareCheckpoint } = await import('./checkpoint.js');
    const history: Message[] = [
        { role: 'user', content: 'Find the discrepancy' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'read', name: 'read', args: {} }] },
        { role: 'tool_result', toolCallId: 'read', content: 'original evidence '.repeat(500) },
        { role: 'assistant', content: 'Recent observation' },
    ];
    const original = structuredClone(history);
    const execution = createHarnessExecution({ context: budgetedContext('', 2000, {
        minRecentGroups: 1, referenceToolResult: () => 'read saved source',
    }), provider: { turn: async () => { throw new Error('No dispatch while fitting'); }, structured: async () => { throw new Error('unused'); } } });
    const view = checkpointView(history);
    const task = await execution.prepareModel({ messages: view.messages, maxTokens: 100 });
    expect(task.report!.decisions.some(d => d.reason === 'budget' && d.action === 'compressed')).toBe(true);
    expect(task.report!.decisions.some(d => d.action === 'dropped')).toBe(false);
    expect(checkpointBoundary(view, task.report!)).toBe(3);
    const selected = await prepareCheckpoint(execution, history, view, task.report!, { maxTokens: 100 });
    expect(selected).toBeDefined();
    // The source may require chunks, but never includes the protected recent group.
    expect(selected!.sourceRange.end).toBeLessThanOrEqual(3);
    expect(selected!.prepared.request.messages[0].content).toContain('original evidence');
    expect(history).toEqual(original);
});

it('does not checkpoint fitting presentation caps or protected-only shortening', async () => {
    const { createHarnessExecution } = await import('./execution.js');
    const { prepareCheckpoint } = await import('./checkpoint.js');
    const history: Message[] = [
        { role: 'assistant', content: '', toolCalls: [{ id: 'read', name: 'read', args: {} }] },
        { role: 'tool_result', toolCallId: 'read', content: 'evidence '.repeat(1000) },
        { role: 'assistant', content: 'Recent observation' },
    ];
    const view = checkpointView(history);
    const execution = createHarnessExecution({ provider: {
        turn: async () => { throw new Error('unexpected dispatch'); }, structured: async () => { throw new Error('unused'); },
    } });
    for (const policy of [{ minRecentGroups: 1, maxToolResultCharacters: 1000 }, { minRecentGroups: 2 }]) {
        const report = await composeAgentContext({ messages: view.messages, tokenBudget: 1500 }, {
            ...policy, referenceToolResult: () => 'read saved source',
        });
        expect(report.decisions.find(d => d.action === 'compressed')?.reason).toBe(policy.maxToolResultCharacters === undefined ? 'budget' : 'presentation');
        expect(report.decisions.some(d => d.action === 'compressed')).toBe(true);
        expect(checkpointBoundary(view, report)).toBeUndefined();
        expect(await prepareCheckpoint(execution, history, view, report, { maxTokens: 100 })).toBeUndefined();
    }
});

it('does not mistake a presentation cap for history pressure when a section needs compression', async () => {
    const history: Message[] = [
        { role: 'assistant', content: '', toolCalls: [{ id: 'read', name: 'read', args: {} }] },
        { role: 'tool_result', toolCallId: 'read', content: 'evidence '.repeat(1000) },
        { role: 'assistant', content: 'Recent observation' },
    ];
    const view = checkpointView(history);
    const report = await composeAgentContext({ messages: view.messages, tokenBudget: 1500,
        sections: [{ id: 'background', priority: -1, text: () => 'background '.repeat(1000) }],
    }, { minRecentGroups: 1, maxToolResultCharacters: 1000, referenceToolResult: () => 'read saved source', compressSection: () => 'short background' });
    expect(report.decisions.find(d => d.kind === 'section')).toMatchObject({ action: 'compressed', reason: 'budget' });
    expect(report.decisions.find(d => d.kind === 'messages' && d.action === 'compressed')).toMatchObject({ reason: 'presentation' });
    expect(checkpointBoundary(view, report)).toBeUndefined();
});

it('can checkpoint before compression using the context-owned ceiling, preserving the recent tail', async () => {
    const { createHarnessExecution } = await import('./execution.js');
    const { budgetedContext } = await import('./defaults.js');
    const { prepareCheckpoint } = await import('./checkpoint.js');
    const history: Message[] = Array.from({ length: 5 }, () => ({ role: 'assistant', content: 'x'.repeat(1000) }));
    const execution = createHarnessExecution({ context: budgetedContext('', 2000, { minRecentGroups: 1 }),
        provider: { turn: async () => { throw new Error('No dispatch while fitting'); }, structured: async () => { throw new Error('unused'); } } });
    const view = checkpointView(history);
    const task = await execution.prepareModel({ messages: view.messages, maxTokens: 100 });
    expect(task.report?.tokenBudget).toBe(2000);
    expect(task.report!.usage.totalTokens).toBeGreaterThanOrEqual(1300);
    expect(task.report!.decisions.every(d => d.action === 'kept')).toBe(true);
    expect(await prepareCheckpoint(execution, history, view, task.report!, { maxTokens: 100 })).toBeUndefined();
    const selected = await prepareCheckpoint(execution, history, view, task.report!, { maxTokens: 100, triggerRatio: 0.65 });
    expect(selected?.through).toBe(4);
    const previous = { through: selected!.through, text: 'Earlier facts preserved.' };
    const nextView = checkpointView(history, previous);
    expect(nextView.messages.at(-1)).toEqual(history.at(-1));
    const next = await execution.prepareModel({ messages: nextView.messages, maxTokens: 100 });
    expect(await prepareCheckpoint(execution, history, nextView, next.report!, { previous, maxTokens: 100, triggerRatio: 0.65 })).toBeUndefined();

    const { tokenBudget: _budget, ...unknownCeiling } = task.report!;
    expect(await prepareCheckpoint(execution, history, view, unknownCeiling, { maxTokens: 100, triggerRatio: 0.65 })).toBeUndefined();
    const protectedReport = { ...task.report!, decisions: task.report!.decisions.map(d => ({ ...d, protected: true })) };
    expect(await prepareCheckpoint(execution, history, view, protectedReport, { maxTokens: 100, triggerRatio: 0.65 })).toBeUndefined();
    for (const triggerRatio of [0, -1, NaN, Infinity, 1.01])
        await expect(prepareCheckpoint(execution, history, view, task.report!, { maxTokens: 100, triggerRatio })).rejects.toThrow('triggerRatio');
});

it('accepts only complete bounded checkpoint text and persists only checkpoint fields', async () => {
    const { checkpointFromResponse, CHECKPOINT_MAX_CHARACTERS } = await import('./checkpoint.js');
    const response = { message: { role: 'assistant' as const, content: 'x'.repeat(CHECKPOINT_MAX_CHARACTERS) }, stopReason: 'end_turn' as const };
    const selection = { through: 3, prepared: { private: true }, partial: { end: 5, offset: 20 } };
    const accepted = checkpointFromResponse(selection, response);
    expect(accepted).toEqual({ ok: true, checkpoint: { through: 3, partial: selection.partial, text: response.message.content } });
    if (accepted.ok) accepted.checkpoint.partial!.offset = 99;
    expect(selection.partial.offset).toBe(20);
    expect(checkpointFromResponse(selection, { ...response, stopReason: 'max_tokens' })).toEqual({ ok: false, reason: 'incomplete' });
    expect(checkpointFromResponse(selection, { ...response, message: { ...response.message, content: ' ' } })).toEqual({ ok: false, reason: 'empty' });
    expect(checkpointFromResponse(selection, { ...response, message: { ...response.message, content: response.message.content + 'x' } })).toEqual({ ok: false, reason: 'too_large' });
    expect(checkpointFromResponse(selection, { ...response, message: { ...response.message, toolCalls: [{ id: 'a', name: 'write', args: {} }] } })).toEqual({ ok: false, reason: 'tool_calls' });
    const request = checkpointRequest([{ role: 'assistant', content: 'evidence' }], 1);
    expect(JSON.parse(request.messages[0].content).output.maxCharacters).toBe(CHECKPOINT_MAX_CHARACTERS);
});
