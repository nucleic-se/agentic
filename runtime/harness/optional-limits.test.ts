import { expect, it } from 'vitest';
import { conversationalLoop } from './loops.js';
import { createHarness } from './host.js';
import { MemorySessionStore } from './stores.js';
import { budgetedContext } from './context.js';
import type { LoopServices } from './types.js';

it('does not silently impose a twenty-response loop limit', async () => {
    let responses = 0;
    const services = { signal: new AbortController().signal, takeQueued: async () => [],
        context: async () => ({ messages: [] }), tools: { executeBatch: async () => [] },
        model: { request: async () => ({ message: { role: 'assistant', content: '',
            ...(responses++ < 45 ? { toolCalls: [{ id: String(responses), name: 'read', args: {} }] } : {}) },
            stopReason: responses <= 45 ? 'tool_use' : 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }) } } as unknown as LoopServices;
    await expect(conversationalLoop().run(services)).resolves.toBeUndefined();
    expect(responses).toBe(46);
});
it('pauses at an explicit request budget and resumes the original input without replaying effects', async () => {
    let calls = 0, tools = 0;
    const store = new MemorySessionStore();
    const client = await createHarness().compose({ limits: { maxModelCalls: 1 }, extensions: [{ id: 'test', version: '1', apiVersion: 1, roles: {
        store: () => store, loop: () => conversationalLoop(), context: () => budgetedContext('', 8000),
        provider: () => ({ structured: async () => { throw Error('unused'); }, turn: async () => ({
            message: { role: 'assistant' as const, content: calls++ ? 'done' : '',
                ...(calls === 1 ? { toolCalls: [{ id: 'once', name: 'read', args: {} }] } : {}) },
            stopReason: calls === 1 ? 'tool_use' as const : 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } }) }),
        tools: () => ({ tools: () => [{ name: 'read', description: '', parameters: { type: 'object' } }],
            validate: () => ({ ok: true as const, args: {} }), call: async () => { tools++; return { ok: true, content: 'observed' }; } }),
        policy: () => ({ evaluate: async () => ({ kind: 'allow' as const }) }),
    } }] });
    try {
        const session = await client.create();
        await client.submit(session.id, 'work', { commandId: 'original', metadata: { origin: 'test' } });
        const paused = await client.wait(session.id);
        expect(paused.status).toBe('paused');
        expect(paused.inputReceipts?.[0].status).toBe('paused');
        await (client as any).resume(session.id);
        const done = await client.wait(session.id);
        expect(done.status).toBe('idle');
        expect(done.inputReceipts?.[0]).toMatchObject({ commandId: 'original', status: 'completed', response: 'done' });
        expect(tools).toBe(1);
    } finally { await client.close(); }
});
