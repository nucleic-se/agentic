import { describe, expect, it, vi } from 'vitest';
import type { ILLMProvider, TurnResponse } from '../contracts/llm.js';
import type { IValidatedToolRuntime, ToolCallResult } from '../contracts/tool-runtime.js';
import { delegationToolRuntime, type DelegationResult } from './delegation.js';
import { MemorySessionStore } from '../runtime/harness/stores.js';
import { createDefaultAgent } from '../runtime/harness/preset.js';

const answer = (content = 'Done'): TurnResponse => ({ message: { role: 'assistant', content }, stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 3 } });
const provider = (turn: ILLMProvider['turn']): ILLMProvider => ({ turn, structured: async () => { throw new Error('Unexpected structured call'); } });
const task = (prompt: string) => ({ worker: 'research', prompt });
const results = (result: ToolCallResult) => result.data as DelegationResult[];
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}
function workerTools(name = 'read', effect: 'read' | 'write' | undefined = 'read'): IValidatedToolRuntime {
    return {
        tools: () => [{ name, description: 'Fixture capability', parameters: { type: 'object', properties: {} } }],
        validate: (_name, args) => ({ ok: true, args }),
        call: vi.fn(async () => ({ ok: true, content: 'Evidence' })),
        effectFor: () => effect,
        close: vi.fn(async () => undefined),
    };
}

describe('delegation child sessions', () => {
    it('composes with the default parent, requires approval, and closes the addon with the parent', async () => {
        const childTurn = vi.fn(async () => answer('Child evidence'));
        const runtime = delegationToolRuntime({ maxModelCalls: 1, workers: { research: { description: 'Research', system: '', provider: provider(childTurn) } } });
        const parentProvider: ILLMProvider = {
            ...provider(async request => {
                const delegated = request.messages.find(message => message.role === 'tool_result' && message.toolCallId === 'delegate-1');
                if (delegated) {
                    expect(delegated.content).toContain('"status":"completed"');
                    expect(delegated.content).toContain('Child evidence');
                    return answer('Parent conclusion');
                }
                return { ...answer(), stopReason: 'tool_use', message: { role: 'assistant', content: '', toolCalls: [{ id: 'delegate-1', name: 'delegate', args: { tasks: [task('Inspect')] } }] } };
            }),
            configurationIdentity: 'delegation-integration-fake-v1',
        };
        const parent = await createDefaultAgent({
            workspace: process.cwd(), provider: parentProvider, tokenBudget: 16000,
            additionalToolsIdentity: 'delegation-integration-v1', additionalTools: () => runtime,
        });
        try {
            const session = await parent.create();
            await parent.submit(session.id, 'Delegate the research', { commandId: 'integration' });
            await vi.waitFor(async () => expect((await parent.get(session.id)).approvals).toHaveLength(1));
            const pending = await parent.get(session.id);
            expect(childTurn).not.toHaveBeenCalled();
            await parent.approve(session.id, pending.approvals[0].id, true);
            const completed = await parent.wait(session.id);
            expect(completed.status, completed.error).toBe('idle');
            expect(completed.error).toBeUndefined();
            expect(completed.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Parent conclusion' });
            expect(childTurn).toHaveBeenCalledTimes(1);
        } finally { await parent.close(); }
        expect(await runtime.call('delegate', { tasks: [task('After parent close')] })).toMatchObject({ ok: false, errorKind: 'cancelled' });
    });

    it('runs independent children in parallel, keeps result order, and rejects excess concurrent batches before factories', async () => {
        const release = deferred();
        const entered: string[] = [];
        const factory = vi.fn(() => workerTools());
        const runtime = delegationToolRuntime({ maxModelCalls: 6, maxConcurrent: 2, workers: { research: {
            description: 'Research', system: 'Worker system', tools: factory,
            provider: provider(async request => {
                expect(request.system).toBe('Worker system');
                expect(request.messages).toHaveLength(1);
                const prompt = request.messages[0].content;
                entered.push(prompt);
                await release.promise;
                return answer(prompt);
            }),
        } } });
        const running = runtime.call('delegate', { tasks: [task('First'), task('Second')] });
        try {
            await vi.waitFor(() => expect(entered).toHaveLength(2));
            const excess = await runtime.call('delegate', { tasks: [task('Third')] });
            expect(excess).toMatchObject({ ok: false, errorKind: 'runtime' });
            expect(factory).toHaveBeenCalledTimes(2);
        } finally { release.resolve(); }
        const result = await running;
        expect(result.ok).toBe(true);
        expect(results(result).map(child => child.answer)).toEqual(['First', 'Second']);
        expect(new Set(results(result).map(child => child.sessionId)).size).toBe(2);
        await runtime.close?.();
    });

    it('charges failed calls and enforces one allowance across racing batches', async () => {
        const releaseFactories = deferred();
        const turn = vi.fn(async () => { throw new Error('Provider failed'); });
        const runtime = delegationToolRuntime({ maxModelCalls: 1, maxConcurrent: 2, workers: { research: {
            description: 'Research', system: '', provider: provider(turn),
            tools: async () => { await releaseFactories.promise; return workerTools(); },
        } } });
        const first = runtime.call('delegate', { tasks: [task('First')] });
        const second = runtime.call('delegate', { tasks: [task('Second')] });
        releaseFactories.resolve();
        const batches = await Promise.all([first, second]);
        expect(turn).toHaveBeenCalledTimes(1);
        expect(batches.flatMap(results).map(child => child.status)).toEqual(['failed', 'failed']);
        expect(batches.flatMap(results).reduce((sum, child) => sum + child.modelCalls, 0)).toBe(1);
        expect(batches.flatMap(results).find(child => child.modelCalls === 1)?.usageComplete).toBe(false);
        expect(batches.flatMap(results).find(child => child.modelCalls === 0)?.usageComplete).toBe(true);
        expect(await runtime.call('delegate', { tasks: [task('Later')] })).toMatchObject({ ok: false, errorKind: 'runtime' });
        await runtime.close?.();
    });

    it.each(['abort', 'close'] as const)('%s cancels active work and waits for owned cleanup before returning', async mode => {
        const entered = deferred(), cleanup = deferred();
        const tools = workerTools();
        tools.close = vi.fn(async () => { await cleanup.promise; });
        const abort = new AbortController();
        const runtime = delegationToolRuntime({ maxModelCalls: 2, workers: { research: {
            description: 'Research', system: '', tools: () => tools,
            provider: provider(async (_request, options) => {
                entered.resolve();
                await new Promise<void>((_resolve, reject) => {
                    const cancel = () => reject(options?.signal?.reason ?? new Error('Aborted'));
                    if (options?.signal?.aborted) cancel();
                    else options?.signal?.addEventListener('abort', cancel, { once: true });
                });
                return answer();
            }),
        } } });
        let settled = false;
        const running = runtime.call('delegate', { tasks: [task('Wait')] }, { signal: abort.signal }).then(result => { settled = true; return result; });
        await entered.promise;
        const closing = mode === 'close' ? runtime.close?.() : undefined;
        if (mode === 'abort') abort.abort();
        try {
            await vi.waitFor(() => expect(tools.close).toHaveBeenCalledTimes(1));
            expect(settled).toBe(false);
        } finally { cleanup.resolve(); }
        const result = await running;
        await closing;
        expect(result).toMatchObject({ ok: false, errorKind: 'cancelled' });
        expect(results(result)[0]).toMatchObject({ status: 'cancelled', modelCalls: 1 });
        await runtime.close?.();
        expect(await runtime.call('delegate', { tasks: [task('After close')] })).toMatchObject({ ok: false, errorKind: 'cancelled' });
    });

    it.each([['write', 'write'], ['unknown', undefined], ['delegate', 'read']] as const)('rejects %s worker capability without provider access and releases its runtime', async (name, effect) => {
        const tools = workerTools(name, effect);
        if (effect === undefined) delete tools.effectFor;
        const turn = vi.fn(async () => answer());
        const runtime = delegationToolRuntime({ maxModelCalls: 2, workers: { research: { description: 'Research', system: '', tools: () => tools, provider: provider(turn) } } });
        const result = await runtime.call('delegate', { tasks: [task('Inspect')] });
        expect(result.ok).toBe(false);
        expect(results(result)[0]).toMatchObject({ status: 'failed', modelCalls: 0 });
        expect(turn).not.toHaveBeenCalled();
        expect(tools.close).toHaveBeenCalledTimes(1);
        await runtime.close?.();
    });

    it('bounds parent-visible answers while preserving full session evidence and origin', async () => {
        const onResult = vi.fn(async () => undefined);
        const runtime = delegationToolRuntime({ maxModelCalls: 2, resultChars: 4, onResult, workers: { research: { description: 'Research', system: '', provider: provider(async () => answer('Full evidence')) } } });
        const result = await runtime.call('delegate', { tasks: [task('Inspect')] }, { sessionId: 'parent', callId: 'call' });
        expect(result.ok).toBe(true);
        expect(results(result)[0]).toMatchObject({ status: 'completed', answer: 'Full', truncated: true, usageComplete: true, modelCalls: 1, toolCalls: 0, usage: { inputTokens: 12, outputTokens: 3 } });
        expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ messages: expect.arrayContaining([expect.objectContaining({ content: 'Full evidence' })]) }), { parentSessionId: 'parent', callId: 'call', worker: 'research' });
        await runtime.close?.();
    });

    it('executes an explicitly read-declared tool inside the child loop and accounts for both turns', async () => {
        const tools = workerTools();
        const runtime = delegationToolRuntime({ maxModelCalls: 2, workers: { research: {
            description: 'Research', system: '', tools: () => tools,
            provider: provider(async request => request.messages.some(message => message.role === 'tool_result') ? answer('Checked') : {
                ...answer('Reading'), stopReason: 'tool_use',
                message: { role: 'assistant', content: 'Reading', toolCalls: [{ id: 'read-1', name: 'read', args: {} }] },
            }),
        } } });
        const result = await runtime.call('delegate', { tasks: [task('Inspect')] });
        expect(result.ok).toBe(true);
        expect(results(result)[0]).toMatchObject({ status: 'completed', answer: 'Checked', modelCalls: 2, toolCalls: 1, usage: { inputTokens: 24, outputTokens: 6 } });
        expect(tools.call).toHaveBeenCalledTimes(1);
        expect(tools.close).toHaveBeenCalledTimes(1);
        await runtime.close?.();
    });

    it('validates the entire batch and authorized arguments before invoking any factory', async () => {
        const factory = vi.fn(() => workerTools());
        const runtime = delegationToolRuntime({ maxModelCalls: 2, workers: { research: { description: 'Research', system: '', tools: factory, provider: provider(async () => answer()) } } });
        for (const tasks of [[], [task('Valid'), { worker: 'missing', prompt: 'Invalid' }], [task('Duplicate'), task('Duplicate')], [task('')]]) {
            expect(await runtime.call('delegate', { tasks })).toMatchObject({ ok: false, errorKind: 'validation' });
        }
        expect(await runtime.call('delegate', { tasks: [task('Changed')] }, { authorizedArgs: { tasks: [task('Approved')] } })).toMatchObject({ ok: false, errorKind: 'policy' });
        expect(factory).not.toHaveBeenCalled();
        await runtime.close?.();
    });

    it('registers pending work before a factory synchronously closes the delegation runtime', async () => {
        const cleanup = deferred();
        const tools = workerTools();
        tools.close = vi.fn(async () => { await cleanup.promise; });
        let closed = false;
        let closing: Promise<void> | undefined;
        const runtime = delegationToolRuntime({ maxModelCalls: 1, workers: { research: {
            description: 'Research', system: '', provider: provider(async () => answer()),
            tools: () => {
                closing = runtime.close!().then(() => { closed = true; });
                return tools;
            },
        } } });
        const running = runtime.call('delegate', { tasks: [task('Inspect')] });
        try {
            await vi.waitFor(() => expect(tools.close).toHaveBeenCalledTimes(1));
            expect(closed).toBe(false);
        } finally { cleanup.resolve(); }
        expect(results(await running)[0]).toMatchObject({ status: 'cancelled', modelCalls: 0 });
        await closing;
        expect(closed).toBe(true);
    });

    it('closes tools once when child composition fails during recovery', async () => {
        const tools = workerTools();
        const recovery = vi.spyOn(MemorySessionStore.prototype, 'list').mockRejectedValueOnce(new Error('Recovery failed'));
        const turn = vi.fn(async () => answer());
        const runtime = delegationToolRuntime({ maxModelCalls: 1, workers: { research: { description: 'Research', system: '', tools: () => tools, provider: provider(turn) } } });
        try {
            const result = await runtime.call('delegate', { tasks: [task('Inspect')] });
            expect(results(result)[0]).toMatchObject({ status: 'failed', modelCalls: 0 });
            expect(results(result)[0].error).toContain('Recovery failed');
            expect(tools.close).toHaveBeenCalledTimes(1);
            expect(turn).not.toHaveBeenCalled();
        } finally { recovery.mockRestore(); await runtime.close?.(); }
    });

    it('cancels a deferred factory through its signal and releases the eventually acquired runtime', async () => {
        const entered = deferred(), release = deferred();
        const tools = workerTools(), abort = new AbortController();
        const turn = vi.fn(async () => answer());
        let factorySignal: AbortSignal | undefined;
        const runtime = delegationToolRuntime({ maxModelCalls: 1, workers: { research: {
            description: 'Research', system: '', provider: provider(turn),
            tools: async signal => { factorySignal = signal; entered.resolve(); await release.promise; return tools; },
        } } });
        let settled = false;
        const running = runtime.call('delegate', { tasks: [task('Inspect')] }, { signal: abort.signal }).then(result => { settled = true; return result; });
        await entered.promise;
        abort.abort();
        expect(factorySignal?.aborted).toBe(true);
        expect(settled).toBe(false);
        release.resolve();
        expect(results(await running)[0]).toMatchObject({ status: 'cancelled', modelCalls: 0, usageComplete: true });
        expect(tools.close).toHaveBeenCalledTimes(1);
        expect(turn).not.toHaveBeenCalled();
        await runtime.close?.();
    });

    it('denies an invented shell capability with no tools and retains partial text as failed', async () => {
        const onResult = vi.fn(async () => undefined);
        const turn = vi.fn(async (): Promise<TurnResponse> => ({
            ...answer(), stopReason: 'tool_use',
            message: { role: 'assistant', content: 'Partial investigation', toolCalls: [{ id: 'shell-1', name: 'shell', args: { command: 'touch forbidden' } }] },
        }));
        const runtime = delegationToolRuntime({ maxModelCalls: 2, workerModelCalls: 1, onResult, workers: { research: { description: 'Research', system: '', provider: provider(turn) } } });
        const result = await runtime.call('delegate', { tasks: [task('Inspect')] });
        expect(result.ok).toBe(false);
        expect(results(result)[0]).toMatchObject({ status: 'failed', answer: 'Partial investigation', modelCalls: 1, toolCalls: 0, usageComplete: true });
        expect(turn).toHaveBeenCalledWith(expect.objectContaining({ tools: [] }), expect.anything());
        expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ messages: expect.arrayContaining([expect.objectContaining({ role: 'tool_result', isError: true })]) }), expect.anything());
        await runtime.close?.();
    });

    it.each([undefined, { inputTokens: NaN, outputTokens: 3 }])('does not mark malformed provider usage complete', async usage => {
        const runtime = delegationToolRuntime({ maxModelCalls: 1, workers: { research: {
            description: 'Research', system: '',
            provider: provider(async () => ({ ...answer(), usage } as TurnResponse)),
        } } });
        const result = await runtime.call('delegate', { tasks: [task('Inspect')] });
        expect(results(result)[0]).toMatchObject({ status: 'failed', modelCalls: 1, usageComplete: false });
        await runtime.close?.();
    });
});
