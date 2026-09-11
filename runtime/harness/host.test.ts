import { inspectOperation } from './inspection.js';
import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createHarness } from './host.js';
import { MemorySessionStore } from './stores.js';
import { conversationalLoop, planningLoop, fullHistoryContext, budgetedContext } from './defaults.js';
import type { Extension, SessionClient, SessionStore, LoopStrategy } from './types.js';
import type { ILLMProvider, TurnResponse } from '../../contracts/llm.js';
import type { IValidatedToolRuntime } from '../../contracts/tool-runtime.js';
const usage = { inputTokens: 1, outputTokens: 1 };
const answer: TurnResponse = { message: { role: 'assistant', content: 'done' }, stopReason: 'end_turn', usage };
const proposal: TurnResponse = { message: { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'write', args: { path: 'safe' } }] }, stopReason: 'tool_use', usage };
function setup(responses: TurnResponse[] = [answer], extra: { store?: SessionStore; loop?: LoopStrategy; confirm?: boolean; execute?: () => Promise<any> } = {}) {
    let n = 0;
    const provider: ILLMProvider = { turn: vi.fn(async () => structuredClone(responses[n++] ?? answer)), structured: async () => { throw new Error('unused'); }, embed: async () => [] };
    const tools: IValidatedToolRuntime = { tools: () => [], validate: (_name, args) => ({ ok: true, args }), call: vi.fn(extra.execute ?? (async () => ({ ok: true, content: 'written' }))) };
    const store = extra.store ?? new MemorySessionStore();
    const extensions: Extension[] = [{ id: 'test', version: '1', apiVersion: 1, roles: { store: () => store, loop: () => extra.loop ?? conversationalLoop(), provider: () => provider, tools: () => tools, context: () => fullHistoryContext(), policy: () => ({ evaluate: async () => extra.confirm ? { kind: 'confirm' as const, reason: 'Approve write' } : { kind: 'allow' as const } }) } }];
    return { extensions, store, provider, tools };
}
async function settled(client: SessionClient, id: string) {
    await vi.waitFor(async () => { const s = await client.get(id); expect(s.operations.length).toBeGreaterThan(0); expect(['idle', 'failed', 'interrupted']).toContain(s.status); });
    return client.get(id);
}
describe('empty harness and effects', () => {
    it('journals the decoded wire request between model intent and completion', async () => {
        const config = setup();
        const request = { url: 'https://provider.example/responses', body: { input: [], parallel_tool_calls: true } };
        config.provider.turn = vi.fn(async (_request, options) => {
            await options?.onRequest?.(request);
            return answer;
        });
        const client = await createHarness().compose(config);
        try {
            const session = await client.create();
            await client.submit(session.id, 'go', { commandId: randomUUID() });
            const record = await settled(client, session.id);
            const events = (await client.events(session.id)).filter(event => event.type.startsWith('model.'));
            expect(events.map(event => event.type)).toEqual(['model.intent', 'model.request', 'model.completed']);
            expect(events[1].data).toEqual({ operationId: record.operations[0].id, request });
        } finally { await client.close(); }
    });
    it('commits unknown timeout before stopping remaining tool effects and model calls', async () => {
        const batch: TurnResponse = { ...proposal, message: { ...proposal.message, toolCalls: [
            { id: 'first', name: 'write', args: { path: 'one' } },
            { id: 'second', name: 'write', args: { path: 'two' } },
        ] } };
        const config = setup([batch, answer], { execute: async () => ({ ok: false, content: 'Timed out after external side effect', errorKind: 'timeout' }) });
        const client = await createHarness().compose(config);
        try {
            const session = await client.create();
            await client.submit(session.id, 'go', { commandId: randomUUID() });
            const record = await client.wait(session.id);
            expect(record.status).toBe('failed');
            expect(record.operations.find(operation => operation.kind === 'tool')?.status).toBe('unknown');
            expect(config.tools.call).toHaveBeenCalledOnce();
            expect(config.provider.turn).toHaveBeenCalledOnce();
            expect(record.messages.filter(message => message.role === 'tool_result')).toHaveLength(2);
            await expect(client.resume(session.id)).rejects.toThrow('Unknown tool');
        } finally { await client.close(); }
    });
    it('shares close completion and waits for an admitted session creation before closing storage', async () => {
        const config = setup();
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { entered = resolve; });
        const create = config.store.create.bind(config.store);
        vi.spyOn(config.store, 'create').mockImplementation(async record => { entered(); await gate; await create(record); });
        const close = vi.spyOn(config.store, 'close');
        const client = await createHarness().compose(config);
        const creating = client.create('admitted');
        await started;
        const firstClose = client.close(), secondClose = client.close();
        expect(secondClose).toBe(firstClose);
        let finished = false; void firstClose.then(() => { finished = true; });
        try {
            await expect(client.create('too late')).rejects.toThrow('shutting down');
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(finished).toBe(false);
            expect(close).not.toHaveBeenCalled();
        } finally { release(); }
        expect((await creating).title).toBe('admitted');
        await Promise.all([firstClose, secondClose]);
        expect(close).toHaveBeenCalledOnce();
        expect(client.close()).toBe(firstClose);
    });
    it('drains accepted input commits during close without launching new work', async () => {
        const config = setup(), client = await createHarness().compose(config);
        const session = await client.create();
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { entered = resolve; });
        const commit = config.store.commit.bind(config.store);
        vi.spyOn(config.store, 'commit').mockImplementation(async (...args) => { entered(); await gate; await commit(...args); });
        const originalClose = config.store.close.bind(config.store);
        let queuedAtClose: unknown;
        const close = vi.spyOn(config.store, 'close').mockImplementation(async () => {
            queuedAtClose = (await config.store.get(session.id))?.queue;
            await originalClose();
        });
        const submit = client.submit(session.id, 'preserve me', { commandId: 'accepted-input' });
        await started;
        const closing = client.close();
        try {
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(close).not.toHaveBeenCalled();
        } finally { release(); }
        await submit; await closing;
        expect(queuedAtClose).toEqual([{ id: 'accepted-input', content: 'preserve me', mode: 'enqueue' }]);
        expect(config.provider.turn).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledOnce();
    });
    it('rejects malformed proposals before committing conversation history', async () => {
        const invalid = structuredClone(proposal);
        invalid.message.toolCalls!.push(structuredClone(invalid.message.toolCalls![0]));
        const config = setup([invalid]);
        const client = await createHarness().compose(config);
        try {
            const session = await client.create();
            await client.submit(session.id, 'go', { commandId: randomUUID() });
            const record = await settled(client, session.id);
            expect(record.status).toBe('failed');
            expect(record.messages.map(m => m.role)).toEqual(['user']);
            expect(config.tools.call).not.toHaveBeenCalled();
        } finally { await client.close(); }
    });
    it('validates the entire composition before executing factories', async () => {
        const factory = vi.fn(); const host = createHarness();
        await expect(host.compose({ extensions: [] })).rejects.toThrow('Missing harness roles');
        await expect(host.compose({ extensions: [{ id: 'one', version: '1', apiVersion: 1, roles: { store: factory } }, { id: 'two', version: '1', apiVersion: 1, roles: { store: factory } }] })).rejects.toThrow('Conflicting owners');
        expect(factory).not.toHaveBeenCalled();
    });
    it('cleans up activations in reverse order on failure', async () => {
        const { extensions, store } = setup(); const cleanups: string[] = [];
        vi.spyOn(store, 'close').mockImplementation(async () => { cleanups.push('store'); });
        extensions.push({ id: 'a', version: '1', apiVersion: 1, activate: async () => () => { cleanups.push('a'); } }, { id: 'b', version: '1', apiVersion: 1, requires: ['a'], activate: async () => { throw new Error('failed'); } });
        await expect(createHarness().compose({ extensions })).rejects.toThrow('failed'); expect(cleanups).toEqual(['a','store']);
    });
    it('commits inputs, model receipts and tool results without duplicate projection', async () => {
        const config = setup([proposal, answer]); const client = await createHarness().compose(config);
        try {
            const s = await client.create(); const commandId = randomUUID();
            await client.submit(s.id, 'go', { commandId });
            const result = await settled(client, s.id);
            expect(result.messages.map(m => m.role)).toEqual(['user','assistant','tool_result','assistant']);
            expect(result.operations.map(o => o.kind)).toEqual(['model','tool','model']);
            expect(result.operations.every(o => o.status === 'completed')).toBe(true);
            const events = await client.events(s.id); expect(events.map(e => e.sequence)).toEqual(events.map((_, i) => i+1));
            await client.submit(s.id, 'go', { commandId }); expect(config.provider.turn).toHaveBeenCalledTimes(2);
        } finally { await client.close(); }
    });
    it.each([false, true])('supports two loops against the same context/tool services (planning=%s)', async planning => {
        const config = setup([answer, answer], { loop: planning ? planningLoop() : conversationalLoop() });
        config.extensions[0].roles!.context = () => budgetedContext('', 1000);
        const client = await createHarness().compose(config);
        try { const s = await client.create(); await client.submit(s.id, 'go', {commandId:randomUUID()}); const r = await settled(client,s.id); expect(r.operations.length).toBe(planning ? 2 : 1); }
        finally { await client.close(); }
    });
    it('approval survives UI detachment and executes only once', async () => {
        const config = setup([proposal, answer], { confirm: true }); const client = await createHarness().compose(config);
        try {
            const s = await client.create(); const detach = client.subscribe(() => {});
            await client.submit(s.id, 'go', { commandId: randomUUID() }); detach();
            await vi.waitFor(async () => expect((await client.get(s.id)).status).toBe('waiting'));
            const approval = (await client.get(s.id)).approvals[0]; expect(config.tools.call).not.toHaveBeenCalled();
            const other = await client.create(); await expect(client.approve(other.id, approval.id, true)).rejects.toThrow('another session');
            await client.approve(s.id, approval.id, true); await settled(client, s.id);
            await expect(client.approve(s.id, approval.id, true)).rejects.toThrow('stale'); expect(config.tools.call).toHaveBeenCalledOnce();
        } finally { await client.close(); }
    });
    it('denies stale approval after cancellation and leaves complete tool protocol', async () => {
        const config = setup([proposal,answer], { confirm:true }); const client = await createHarness().compose(config);
        try {
            const s = await client.create(); await client.submit(s.id,'go',{commandId:randomUUID()});
            await vi.waitFor(async()=>expect((await client.get(s.id)).approvals.length).toBe(1));
            const approval=(await client.get(s.id)).approvals[0]; await client.cancel(s.id);
            await expect(client.approve(s.id,approval.id,true)).rejects.toThrow();
            const result=await settled(client,s.id); expect(result.status).toBe('interrupted'); expect(config.tools.call).not.toHaveBeenCalled();
            expect(result.messages.some(m=>m.role==='tool_result')).toBe(true);
        } finally {await client.close();}
    });
    it('isolates observer failures from model execution', async () => {
        const config=setup();const client=await createHarness().compose(config);
        try { client.subscribe(()=>{throw new Error('broken UI');}); const s=await client.create();await client.submit(s.id,'go',{commandId:randomUUID()});expect((await settled(client,s.id)).status).toBe('idle'); }
        finally {await client.close();}
    });
    it('forks committed history without approvals, active work or queued inputs', async () => {
        const client=await createHarness().compose(setup());
        try {const s=await client.create();await client.submit(s.id,'go',{commandId:randomUUID()});const parent=await settled(client,s.id);const child=await client.fork(s.id);expect(child.parent).toEqual({sessionId:s.id,revision:parent.revision});expect(child.messages).toEqual(parent.messages);expect(child.commandIds).toEqual([]);expect(child.activeRunId).toBeUndefined();}
        finally {await client.close();}
    });
    it('recovers unresolved effects without repeating them', async () => {
        const config=setup();const client=await createHarness().compose(config);const s=await client.create();
        // Simulate a durable record from a killed owner; current store has no background run.
        const record={...s,revision:1,status:'running' as const,activeRunId:'old',messages:[proposal.message],operations:[{id:'op',runId:'old',kind:'tool' as const,status:'intent' as const,input:{},createdAt:Date.now()}]};
        await config.store.commit(s.id,0,record,{schemaVersion:1,id:randomUUID(),sessionId:s.id,sequence:1,type:'tool.intent',timestamp:Date.now()});
        const recovered=await createHarness().compose({...config,extensions:config.extensions});
        try {const r=await recovered.get(s.id);expect(r.status).toBe('interrupted');expect(r.operations[0].status).toBe('unknown');expect(r.messages[1].role).toBe('tool_result');await expect(recovered.resume(s.id)).rejects.toThrow('Unknown tool');expect(config.tools.call).not.toHaveBeenCalled();}
        finally {await recovered.close();}
    });
});

describe('approved architectural guarantees', () => {
    it('cancels and drains activated work before disposing a failed composition', async () => {
        let entered!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        let loopSignal: AbortSignal | undefined;
        const config = setup([], { loop: { async run(services) {
            loopSignal = services.signal; entered();
            await new Promise<void>(resolve => { services.signal.addEventListener('abort', () => resolve(), { once: true }); });
        } } });
        const closed = vi.spyOn(config.store, 'close');
        config.extensions[0].activate = async client => {
            const session = await client.create();
            await client.submit(session.id, 'start', { commandId: 'activation' });
            await started;
        };
        config.extensions.push({ id: 'broken', version: '1', apiVersion: 1, requires: ['test'], activate: async () => { throw new Error('activation failed'); } });
        await expect(createHarness().compose(config)).rejects.toThrow('activation failed');
        expect(loopSignal?.aborted).toBe(true);
        expect(closed).toHaveBeenCalledOnce();
    });
    it('journals evidence-based resolution without replaying an uncertain tool', async () => {
        const config = setup([proposal, answer], { execute: async () => ({ ok: false, content: 'connection lost after write', errorKind: 'unknown' }) });
        const client = await createHarness().compose(config);
        try {
            const session = await client.create();
            await client.submit(session.id, 'write', { commandId: 'write' });
            const blocked = await client.wait(session.id);
            const op = blocked.operations.find(op => op.kind === 'tool')!;
            expect(op.status).toBe('unknown');
            await expect(client.resume(session.id)).rejects.toThrow('Unknown tool');
            const resolution = { expectedRevision: blocked.revision, evidence: 'Read destination: expected content exists', result: { ok: true, content: 'Write verified' } };
            await expect(client.resolveOperation(session.id, op.id, { ...resolution, expectedRevision: blocked.revision - 1 })).rejects.toThrow('revision');
            const resolved = await client.resolveOperation(session.id, op.id, resolution);
            expect(resolved.messages.find(m => m.role === 'tool_result')?.content).toBe('Write verified');
            await expect(client.resolveOperation(session.id, op.id, { ...resolution, expectedRevision: resolved.revision })).rejects.toThrow('not an unresolved');
            expect((await client.events(session.id)).some(event => event.type === 'tool.resolved')).toBe(true);
            await client.resume(session.id); expect((await client.wait(session.id)).status).toBe('idle');
            expect(config.tools.call).toHaveBeenCalledOnce();
        } finally { await client.close(); }
    });
    it('honors explicit model-call limits before another dispatch', async () => {
        const config = setup([proposal, answer]);
        const client = await createHarness().compose({ ...config, limits: { maxModelCalls: 1 } });
        try {
            const session = await client.create(); await client.submit(session.id, 'go', { commandId: 'limit' });
            const record = await client.wait(session.id);
            expect(record.error).toMatch(/model-call budget/);
            expect(config.provider.turn).toHaveBeenCalledOnce();
        } finally { await client.close(); }
    });
    it('journals the context report without passing it to the provider', async () => {
        const config = setup(); config.extensions[0].roles!.context = () => budgetedContext('instruction', 1000);
        const client = await createHarness().compose(config);
        try {
            const session = await client.create(); await client.submit(session.id, 'go', { commandId: 'report' });
            const record = await client.wait(session.id);
            expect((await inspectOperation(client, record.id, record.operations[0].id)).contextReport?.usage.totalTokens).toBeGreaterThan(0);
            const request = vi.mocked(config.provider.turn).mock.calls[0][0];
            expect(request).not.toHaveProperty('report');
        } finally { await client.close(); }
    });
});


it.each([false, true])('keeps the host stopped after a caught unknown effect (receipt storage failure: %s)', async failReceipt => {
    const store = new MemorySessionStore();
    const commit = store.commit.bind(store);
    let failed = false;
    vi.spyOn(store, 'commit').mockImplementation(async (...args) => {
        if (failReceipt && !failed && args[3].type === 'tool.completed') { failed = true; throw new Error('Receipt storage unavailable'); }
        return commit(...args);
    });
    const config = setup([], { store, execute: async () => ({ ok: false, content: 'Lost receipt', errorKind: 'unknown' }),
        loop: { async run(services) {
            const call = { id: 'uncertain', name: 'write', args: {} };
            const suffix = { ...call, id: 'suffix' };
            await services.append([{ role: 'assistant', content: '', toolCalls: [call, suffix] }]);
            await expect(services.tools.executeBatch([call, suffix])).rejects.toThrow('unknown');
            await expect(services.tools.executeBatch([{ ...call, id: 'later' }])).rejects.toThrow('unknown');
            await expect(services.model.request({ messages: [] })).rejects.toThrow('unknown');
        } },
    });
    const client = await createHarness().compose(config);
    try {
        const session = await client.create();
        await client.submit(session.id, 'go', { commandId: randomUUID() });
        const record = await client.wait(session.id);
        expect(record.status).toBe('failed');
        expect(record.operations.map(op => op.status)).toEqual(['unknown']);
        expect(record.messages.filter(message => message.role === 'tool_result').map(message => message.toolCallId)).toEqual(['uncertain', 'suffix']);
        expect(config.tools.call).toHaveBeenCalledOnce();
        expect(config.provider.turn).not.toHaveBeenCalled();
    } finally { await client.close(); }
});
