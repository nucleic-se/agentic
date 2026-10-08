import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness } from './host.js';
import { MemorySessionStore } from './stores.js';
import { conversationalLoop, fullHistoryContext, budgetedContext } from './defaults.js';
import type { SessionClient, SessionRecord } from './types.js';
import type { ILLMProvider, TurnResponse } from '../../contracts/llm.js';

const clients: SessionClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())); });
const answer: TurnResponse = { message: { role: 'assistant', content: 'summary' }, stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 1, reasoningTokens: 1, totalTokens: 5, costUsd: 0.01 } };
async function setup(options: { store?: MemorySessionStore; provider?: ILLMProvider; budget?: number } = {}) {
    const store = options.store ?? new MemorySessionStore();
    const provider: ILLMProvider = options.provider ?? { turn: vi.fn(async () => structuredClone(answer)), structured: async () => { throw new Error('unused'); }, embed: async () => [] };
    const client = await createHarness().compose({ extensions: [{ id: 'test', version: '1', apiVersion: 1, roles: {
        store: () => store, provider: () => provider, loop: () => conversationalLoop(),
        context: () => options.budget ? budgetedContext('ordinary', options.budget) : fullHistoryContext('ordinary'),
        tools: () => ({ tools: () => [], validate: (_name, args) => ({ ok: true as const, args }), call: async () => ({ ok: true, content: 'ok' }) }),
        policy: () => ({ evaluate: async () => ({ kind: 'allow' as const }) }),
    } }] });
    clients.push(client);
    const created = await client.create();
    const initial = await client.replaceMessages(created.id, created.revision, [{ role: 'user', content: 'original history' }]);
    return { store, provider, client, initial };
}
const maintenance = { system: 'Summarize the session', maxTokens: 20, project: (response: TurnResponse) => [{ role: 'user' as const, content: response.message.content }] };

describe('journaled maintenance', () => {
    it('atomically commits receipt, all usage fields and replacement through the shared model service', async () => {
        const { client, initial, provider } = await setup();
        const result = await client.maintain(initial.id, maintenance);
        expect(result.status).toBe('idle');
        expect(result.messages).toEqual([{ role: 'user', content: 'summary' }]);
        expect(result.usage).toEqual(answer.usage);
        expect(result.operations[0]).toMatchObject({ kind: 'model', status: 'completed', dispatched: true, output: answer });
        expect(provider.turn).toHaveBeenCalledWith(expect.objectContaining({ system: maintenance.system, tools: [], maxTokens: 20 }), expect.anything());
        const receipt = (await client.events(initial.id)).find(event => event.type === 'model.completed');
        expect(receipt?.data).toMatchObject({ previousMessages: initial.messages, messages: result.messages });
    });
    it('retains the truthful completed receipt when a projector fails', async () => {
        const { client, initial } = await setup();
        await expect(client.maintain(initial.id, { ...maintenance, project: () => { throw new Error('projector failed'); } })).rejects.toThrow('projector failed');
        const result = await client.get(initial.id);
        expect(result.status).toBe('failed');
        expect(result.messages).toEqual(initial.messages);
        expect(result.operations[0]).toMatchObject({ status: 'completed', output: answer });
        expect(result.usage).toEqual(answer.usage);
        expect((await client.events(initial.id)).filter(event => event.type === 'model.failed')).toEqual([]);
    });
    it('propagates falsy projector throws while wait still returns the committed terminal state', async () => {
        const { client, initial } = await setup();
        const pending = client.maintain(initial.id, { ...maintenance, project: () => { throw undefined; } });
        const observed = pending.then(() => ({ rejected: false }), reason => ({ rejected: true, reason }));
        const terminal = await client.wait(initial.id);
        expect(await observed).toEqual({ rejected: true, reason: undefined });
        expect(terminal.status).toBe('failed');
        expect(terminal.messages).toEqual(initial.messages);
        expect(terminal.operations[0]?.status).toBe('completed');
    });
    it('assembles each model request once after the loop finalizes its tool and system settings', async () => {
        const store = new MemorySessionStore(), assemble = vi.fn(async (messages, _signal, options) => ({ system: options?.system ?? 'default', messages }));
        const turn = vi.fn(async () => answer);
        const client = await createHarness().compose({ extensions: [{ id: 'single-context', version: '1', apiVersion: 1, roles: {
            store: () => store, provider: () => ({ turn, structured: async () => { throw new Error('unused'); }, embed: async () => [] }),
            context: () => ({ assemble }),
            loop: () => ({ async run(services) { const raw = await services.context(); await services.model.request({ ...raw, system: 'final instruction', tools: [], maxTokens: 50 }); } }),
            tools: () => ({ tools: () => [{ name: 'unused', description: 'must not be budgeted for this request', parameters: { type: 'object' } }], validate: (_name, args) => ({ ok: true as const, args }), call: async () => ({ ok: true, content: 'ok' }) }),
            policy: () => ({ evaluate: async () => ({ kind: 'allow' as const }) }),
        } }] });
        clients.push(client);
        const session = await client.create(); await client.submit(session.id, 'go', { commandId: 'once' }); await client.wait(session.id);
        expect(assemble).toHaveBeenCalledOnce();
        expect(assemble).toHaveBeenCalledWith([{ role: 'user', content: 'go' }], expect.any(AbortSignal), { system: 'final instruction', tools: [], reservedOutputTokens: 50 });
        expect(turn).toHaveBeenCalledWith(expect.objectContaining({ system: 'final instruction', tools: [], maxTokens: 50 }), expect.anything());
    });
    it('records truncated output without applying a replacement', async () => {
        const provider: ILLMProvider = { turn: async () => ({ ...answer, stopReason: 'max_tokens' }), structured: async () => { throw new Error('unused'); }, embed: async () => [] };
        const { client, initial } = await setup({ provider });
        await expect(client.maintain(initial.id, maintenance)).rejects.toThrow();
        const result = await client.get(initial.id);
        expect(result.messages).toEqual(initial.messages);
        expect(result.operations[0]?.status).toBe('partial');
        expect(result.usage).toEqual(answer.usage);
    });
    it('budgets the maintenance instruction and output reserve before any model dispatch', async () => {
        const { client, initial, provider } = await setup({ budget: 30 });
        await expect(client.maintain(initial.id, { ...maintenance, maxTokens: 100 })).rejects.toThrow();
        expect(provider.turn).not.toHaveBeenCalled();
        expect((await client.get(initial.id)).messages).toEqual(initial.messages);
    });
    it('distinguishes cancellation after intent but before dispatch', async () => {
        const store = new MemorySessionStore();
        const { client, initial, provider } = await setup({ store });
        const commit = store.commit.bind(store);
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { entered = resolve; });
        vi.spyOn(store, 'commit').mockImplementation(async (...args) => { await commit(...args); if (args[3].type === 'model.intent') { entered(); await gate; } });
        const pending = client.maintain(initial.id, maintenance);
        const rejection = expect(pending).rejects.toThrow();
        await started;
        await client.cancel(initial.id); release(); await rejection;
        const result = await client.get(initial.id);
        expect(provider.turn).not.toHaveBeenCalled();
        expect(result.operations[0]).toMatchObject({ status: 'cancelled', dispatched: false });
        expect(result.messages).toEqual(initial.messages);
    });
    it('does not overwrite a failed completed-receipt commit with a false model failure', async () => {
        const store = new MemorySessionStore();
        const { client, initial } = await setup({ store });
        const commit = store.commit.bind(store), attempted: string[] = [];
        vi.spyOn(store, 'commit').mockImplementation(async (...args) => {
            attempted.push(args[3].type);
            if (args[3].type === 'model.completed') throw new Error('receipt disk failure');
            await commit(...args);
        });
        await expect(client.maintain(initial.id, maintenance)).rejects.toThrow('receipt disk failure');
        expect(attempted).not.toContain('model.failed');
        const result = await client.get(initial.id);
        expect(result.operations[0]?.status).toBe('unknown');
        expect(result.messages).toEqual(initial.messages);
        expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    });
    it('reserves maintenance immediately and shutdown waits for its cancelled provider receipt', async () => {
        let entered!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const provider: ILLMProvider = { turn: async (_request, options) => new Promise((_resolve, reject) => { entered(); options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true }); }), structured: async () => { throw new Error('unused'); }, embed: async () => [] };
        const { client, initial, store } = await setup({ provider });
        const close = store.close.bind(store); let snapshot: SessionRecord | undefined;
        vi.spyOn(store, 'close').mockImplementation(async () => { snapshot = await store.get(initial.id); await close(); });
        const pending = client.maintain(initial.id, maintenance), rejection = expect(pending).rejects.toThrow();
        await expect(client.maintain(initial.id, maintenance)).rejects.toThrow('already running');
        await started; await client.close(); await rejection;
        expect(snapshot?.operations[0]).toMatchObject({ status: 'unknown', dispatched: true });
        expect(snapshot?.messages).toEqual(initial.messages);
    });
});

it('uses checkpoint evidence for manual maintenance without streaming internal summaries or losing archived sources', async () => {
    const { agentContext } = await import('./agent-context.js');
    const store = new MemorySessionStore();
    const history = Array.from({ length: 24 }, (_, index) => [
        { role: 'user' as const, content: `Objective ${index}: ${'meeting evidence '.repeat(100)}` },
        { role: 'assistant' as const, content: `Progress ${index}` },
    ]).flat();
    const requests: import('../../contracts/llm.js').TurnRequest[] = [];
    const provider: ILLMProvider = {
        structured: async () => { throw new Error('unused'); },
        streamTurn: async () => { throw new Error('Maintenance must not stream to the user'); },
        turn: async request => { requests.push(structuredClone(request)); return structuredClone(answer); },
    };
    const client = await createHarness().compose({ extensions: [{ id: 'checkpoint-maintenance', version: '1', apiVersion: 1, roles: {
        store: () => store, provider: () => provider, loop: () => conversationalLoop(),
        context: () => agentContext('Host rules', 4000, { protectUserMessages: 'latest', checkpointMaxTokens: 256 }),
        tools: () => ({ tools: () => [], validate: (_name, args) => ({ ok: true as const, args }), call: async () => ({ ok: true, content: '' }) }),
        policy: () => ({ evaluate: async () => ({ kind: 'allow' as const }) }),
    } }] });
    clients.push(client);
    const session = await client.create();
    await client.replaceMessages(session.id, session.revision, history);
    const result = await client.maintain(session.id, maintenance);
    expect(result.status).toBe('idle');
    expect(result.contextState).toBeUndefined();
    expect(result.messages).toEqual([{ role: 'user', content: 'summary' }]);
    expect(requests.length).toBeGreaterThan(2);
    expect(requests.at(-1)!.system).toBe(maintenance.system);
    expect(requests.at(-1)!.messages.some(m => m.content.startsWith('Working checkpoint'))).toBe(true);
    expect(result.usage.inputTokens).toBe(requests.length * answer.usage.inputTokens);
    const events = await client.events(session.id);
    const replacement = events.find(e => e.type === 'model.completed' && (e.data as { previousMessages?: unknown })?.previousMessages);
    expect(replacement?.data).toMatchObject({ previousMessages: history });
});
