import { expect, it, vi } from 'vitest';
import { createHarness } from './host.js';
import { createHarnessExecution } from './execution.js';
import { MemorySessionStore } from './stores.js';
import { conversationalLoop, fullHistoryContext, budgetedContext } from './defaults.js';
import { assertHarnessBoundaryConformance } from '../testing/harness.js';
import type { DriverComposition } from './composition.js';

it('the local session driver satisfies the shared request boundary', async () => {
    const report = await assertHarnessBoundaryConformance(async ({ provider, context }) => {
        const client = await createHarness().compose({ extensions: [{ id: 'fixture', version: '1', apiVersion: 1,
            roles: { provider: () => provider, context: () => context, store: () => new MemorySessionStore(),
                loop: () => conversationalLoop(), policy: () => ({ evaluate: async () => ({ kind: 'allow' }) }),
                tools: () => ({ tools: () => [], validate: (_name, args) => ({ ok: true, args }), call: async () => { throw new Error('Unexpected tool'); } }),
            } }] });
        return { async run(input) {
            const session = await client.create();
            await client.submit(session.id, input, { commandId: 'conformance' });
            return (await client.wait(session.id)).messages;
        }, close: () => client.close() };
    });
    expect(report.passed).toBe(true);
});

it('validates a custom driver composition before any factory or startup', async () => {
    const factory = vi.fn(() => 1), start = vi.fn(async () => ({ close: async () => {} }));
    const composition: DriverComposition<{ resource: number }, { close(): Promise<void> }> = {
        driver: { roles: ['resource'], start }, extensions: [
            { id: 'a', version: '1', apiVersion: 1, requires: ['missing'], roles: { resource: factory } },
        ],
    };
    await expect(createHarness().compose(composition)).rejects.toThrow('Missing extension dependency');
    expect(factory).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
});

it('drains the driver before reverse activation cleanup and role disposal, once', async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const client = await createHarness().compose({ driver: {
        roles: ['resource'], dispose: { resource: async (_value: number) => { events.push('resource'); } },
        start: async () => ({ close: async () => { events.push('stop'); await gate; events.push('drained'); } }),
    }, extensions: [
        { id: 'a', version: '1', apiVersion: 1, roles: { resource: () => 1 }, activate: async () => () => { events.push('a'); } },
        { id: 'b', version: '1', apiVersion: 1, requires: ['a'], activate: async () => () => { events.push('b'); } },
    ] });
    const first = client.close();
    expect(client.close()).toBe(first); expect(events).toEqual(['stop']);
    release(); await first;
    expect(events).toEqual(['stop', 'drained', 'b', 'a', 'resource']);
});

it('releases acquired roles after driver startup fails', async () => {
    const release = vi.fn();
    await expect(createHarness().compose({ driver: {
        roles: ['resource'], dispose: { resource: release }, start: async () => { throw new Error('startup'); },
    }, extensions: [{ id: 'a', version: '1', apiVersion: 1, roles: { resource: () => 1 } }] })).rejects.toThrow('startup');
    expect(release).toHaveBeenCalledOnce();
});

it('preserves shutdown errors while still releasing every acquired resource', async () => {
    const events: string[] = [];
    const client = await createHarness().compose({ driver: {
        roles: ['resource'],
        dispose: { resource: () => { events.push('resource'); } },
        start: async () => ({ close: async () => { events.push('drained'); throw new Error('driver shutdown'); } }),
    }, extensions: [
        { id: 'resource', version: '1', apiVersion: 1, roles: { resource: () => 1 },
            activate: async () => () => { events.push('first'); } },
        { id: 'ui', version: '1', apiVersion: 1,
            activate: async () => () => { events.push('ui'); throw new Error('ui cleanup'); } },
    ] });
    const closing = client.close();
    await expect(closing).rejects.toMatchObject({ errors: [
        expect.objectContaining({ message: 'driver shutdown' }),
        expect.objectContaining({ errors: [expect.objectContaining({ message: 'ui cleanup' })] }),
    ] });
    expect(client.close()).toBe(closing);
    expect(events).toEqual(['drained', 'ui', 'first', 'resource']);
});

it('covers context preparation with the operation deadline and never admits expired work', async () => {
    const turn = vi.fn(), intent = vi.fn();
    const execution = createHarnessExecution({ provider: { turn, structured: vi.fn() }, context: {
        async assemble(_messages, signal) {
            await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
            return { messages: [] };
        },
    } });
    await expect(execution.model({ messages: [] }, { deadline: Date.now() + 20, onIntent: intent })).rejects.toThrow('deadline');
    expect(turn).not.toHaveBeenCalled(); expect(intent).not.toHaveBeenCalled();
});

it('a failed admission hook prevents dispatch without manufacturing a model receipt', async () => {
    const turn = vi.fn(), receipt = vi.fn();
    const execution = createHarnessExecution({ provider: { turn, structured: vi.fn() }, context: fullHistoryContext() });
    await expect(execution.model({ messages: [] }, { onIntent: () => { throw new Error('lost ownership'); }, onOutcome: receipt })).rejects.toThrow('lost ownership');
    expect(turn).not.toHaveBeenCalled(); expect(receipt).not.toHaveBeenCalled();
});

it('rejects inconsistent context accounting before reservation or dispatch', async () => {
    const turn = vi.fn(), prepared = vi.fn();
    const execution = createHarnessExecution({ provider: { turn, structured: vi.fn() }, context: {
        async assemble() { return { messages: [], report: { decisions: [], usage: {
            systemTokens: 0, messageTokens: 0, toolTokens: 0, schemaTokens: 0,
            reservedOutputTokens: 100, totalTokens: 1,
        } } }; },
    } });
    await expect(execution.model({ messages: [], maxTokens: 100 }, { onPrepared: prepared })).rejects.toThrow('accounting');
    expect(prepared).not.toHaveBeenCalled(); expect(turn).not.toHaveBeenCalled();
});

it('does not claim a bounded context when an opaque provider continuation retains uncounted history', async () => {
    const turn = vi.fn(), intent = vi.fn();
    const execution = createHarnessExecution({ provider: { turn, structured: vi.fn() }, context: budgetedContext('', 1000) });
    await expect(execution.model({ messages: [], previousResponseId: 'hidden-history', maxTokens: 100 }, { onIntent: intent })).rejects.toThrow('opaque provider continuation');
    expect(turn).not.toHaveBeenCalled(); expect(intent).not.toHaveBeenCalled();
});

it('inspects the exact admitted request during execution without rebuilding context', async () => {
    const { inspectHarness } = await import('./inspection.js');
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let dispatched: unknown;
    const context = { assemble: vi.fn(budgetedContext('selected system', 2000).assemble) };
    const client = await createHarness().compose({ extensions: [{ id: 'fixture', version: '1', apiVersion: 1,
        roles: { store: () => new MemorySessionStore(), context: () => context,
            provider: () => ({ structured: vi.fn(), turn: async request => {
                dispatched = structuredClone(request); entered(); await gate;
                return { message: { role: 'assistant', content: 'done' }, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2 } };
            } }), loop: () => conversationalLoop({ maxTokens: 100 }),
            tools: () => ({ tools: () => [], validate: (_name, args) => ({ ok: true, args }), call: vi.fn() }),
            policy: () => ({ evaluate: async () => ({ kind: 'allow' }) }),
        } }] });
    try {
        const session = await client.create();
        await client.submit(session.id, 'original objective', { commandId: 'inspect' });
        await started;
        const snapshot = await inspectHarness(client, session.id);
        const op = snapshot.state.operations[0];
        expect(op.status).toBe('intent');
        expect(op.input).toEqual(dispatched);
        expect(op.contextReport?.usage.reservedOutputTokens).toBe(100);
        expect(snapshot.events.every(event => event.sequence <= snapshot.revision)).toBe(true);
        await inspectHarness(client, session.id);
        expect(context.assemble).toHaveBeenCalledOnce();
        snapshot.state.messages.length = 0;
        expect((await client.get(session.id)).messages).toHaveLength(1);
        release(); await client.wait(session.id);
        const finished = await inspectHarness(client, session.id);
        expect(finished.state.operations[0].input).toEqual(dispatched);
        expect(finished.state.operations[0].status).toBe('completed');
    } finally { release(); await client.close(); }
});

it('excludes trace events newer than the captured state', async () => {
    const { inspectHarness } = await import('./inspection.js');
    const store = { get: async () => ({ revision: 3 }), events: vi.fn(async () => [{ sequence: 2 }, { sequence: 3 }, { sequence: 4 }]) };
    const snapshot = await inspectHarness(store, 'test', 1);
    expect(snapshot.events).toEqual([{ sequence: 2 }, { sequence: 3 }]);
    expect(snapshot.nextSequence).toBe(3);
    expect(store.events).toHaveBeenCalledWith('test', 1, 200);
    await expect(inspectHarness(store, 'test', -1)).rejects.toThrow('cursor');
});


it('disposes late activation resources and rejects composition when activation closes the client', async () => {
    const events: string[] = [];
    const lateCleanup = vi.fn(() => { events.push('late cleanup'); });
    const laterActivation = vi.fn();
    const composition: DriverComposition<{ resource: number }, { close(): Promise<void> }> = {
        driver: { roles: ['resource'], start: async () => ({ close: async () => { events.push('stop'); } }),
            dispose: { resource: () => { events.push('dispose'); } } },
        extensions: [
            { id: 'resource', version: '1', apiVersion: 1, roles: { resource: () => 1 } },
            { id: 'closing', version: '1', apiVersion: 1, activate: async client => { await client.close(); return lateCleanup; } },
            { id: 'later', version: '1', apiVersion: 1, activate: laterActivation },
        ],
    };
    await expect(createHarness().compose(composition)).rejects.toThrow('closed during activation');
    expect(events).toEqual(['stop', 'dispose', 'late cleanup']);
    expect(lateCleanup).toHaveBeenCalledOnce();
    expect(laterActivation).not.toHaveBeenCalled();
});
