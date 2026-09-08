import { checkpointContextLifecycle, referenceContextLifecycle, type ContextLifecycle, type CheckpointContextState } from './context-lifecycle.js';
import { afterEach, expect, it } from 'vitest';
import { createHarness } from './host.js';
import { MemorySessionStore } from './stores.js';
import { budgetedContext, conversationalLoop } from './defaults.js';
import type { SessionClient } from './types.js';
import type { TurnRequest, TurnResponse } from '../../contracts/llm.js';

const clients: SessionClient[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.close(); });
async function setup(turn: (request: TurnRequest) => string | TurnResponse, maxModelCalls = 20, lifecycle: ContextLifecycle = checkpointContextLifecycle({ maxTokens: 64, triggerRatio: 0.8 }), system = 'Complete the audit.') {
    const client = await createHarness().compose({ limits: { maxModelCalls }, extensions: [{ id: 'continuity.test', version: '1', apiVersion: 1, roles: {
        store: () => new MemorySessionStore(),
        loop: () => conversationalLoop({ maxTokens: 64 }),
        context: () => ({ ...budgetedContext(system, 3000), lifecycle }),
        provider: () => ({ turn: async request => { const result = turn(request); return typeof result === 'string' ? { message: { role: 'assistant', content: result }, stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } } : result; }, structured: async () => { throw new Error('unused'); } }),
        tools: () => ({ tools: () => [], validate: (_name, args) => ({ ok: true, args }), call: async () => ({ ok: true, content: 'unused' }) }),
        policy: () => ({ evaluate: async () => ({ kind: 'allow' }) }),
    } }] });
    clients.push(client);
    let record = await client.create();
    record = await client.replaceMessages(record.id, record.revision, [
        { role: 'user', content: 'Do not release until verification passes.' },
        ...Array.from({ length: 40 }, (_, index) => ({ role: 'assistant' as const, content: `Observation ${index}: ${'evidence '.repeat(28)}` })),
        { role: 'user', content: 'Correction: security verification is also required.' },
    ]);
    return { client, record };
}
it.each([false, true])('automatically maintains context without replacing sources (reject twice=%s)', async rejectTwice => {
    let drafts = 0;
    const { client, record } = await setup(request => {
        if (/^(Maintain a concise working checkpoint|Repair a rejected working checkpoint)/.test(request.system ?? '')) {
            const input = JSON.parse(request.messages[0].content);
            expect(input.output.targetTokens).toBe(drafts ? 32 : 64);
            drafts++;
            if (drafts === 2) {
                expect(input.rejectedDraft).toBe('too_large');
                expect(input.draft).toBe('x'.repeat(8591));
                expect(input.sources).toBeUndefined();
            }
            return drafts === 1 || rejectTwice ? 'x'.repeat(8591) : 'Inspections recorded. Security verification remains unfinished.';
        }
        expect(request.messages.some(m => m.content.startsWith('Working checkpoint'))).toBe(true);
        expect(request.messages.some(m => m.content === record.messages[0].content)).toBe(true);
        expect(request.messages.some(m => m.content.includes('Correction: security'))).toBe(true);
        return 'done';
    }, 20, undefined, 'Task instruction. '.repeat(250));
    await client.submit(record.id, 'Continue', { commandId: 'continue' });
    const saved = await client.wait(record.id);
    expect(saved.status).toBe(rejectTwice ? 'failed' : 'idle');
    expect(saved.messages.slice(0, record.messages.length)).toEqual(record.messages);
    expect(saved.messages.some(m => m.content === 'x'.repeat(8591))).toBe(false);
    expect(saved.usage.inputTokens).toBe(saved.operations.length * 100);
    const events = await client.events(record.id);
    const decisions = events.map(event => (event.data as { contextDecision?: unknown } | undefined)?.contextDecision).filter(Boolean);
    expect(decisions[0]).toEqual({ pending: true, attempt: 1 });
    if (rejectTwice) {
        expect(drafts).toBe(2);
        expect((saved.contextState as CheckpointContextState).checkpoint).toBeUndefined();
        expect(saved.error).toContain('after two attempts');
    } else {
        expect((saved.contextState as CheckpointContextState).checkpoint?.through).toBeGreaterThan(0);
        expect((saved.contextState as CheckpointContextState).rejected).toBeUndefined();
        expect(saved.messages.at(-1)?.content).toBe('done');
        const reset = await client.replaceMessages(saved.id, saved.revision, saved.messages);
        expect(reset.contextState).toBeUndefined();
    }
});
it('charges maintenance to the same run call budget as task execution', async () => {
    let calls = 0;
    const { client, record } = await setup(request => {
        calls++;
        expect(request.system).toContain('Maintain a concise working checkpoint');
        return 'Source observations recorded; verification remains unfinished.';
    }, 1);
    await client.submit(record.id, 'Continue', { commandId: 'continue' });
    const saved = await client.wait(record.id);
    expect(calls).toBe(1);
    expect(saved.status).toBe('failed');
    expect(saved.error).toContain('model-call budget');
    expect((saved.contextState as CheckpointContextState).candidate?.through).toBeGreaterThan(0);
    expect(saved.usage.inputTokens).toBe(100);
});

it('composes automatic checkpoints and source recovery in the default agent across reopen', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { defaultAgentExtensions } = await import('./preset.js');
    const directory = await mkdtemp(join(tmpdir(), 'default-continuity-'));
    let active: SessionClient | undefined;
    let drafts = 0, tasks = 0;
    const source = 'Exact source: security verification has NOT passed.';
    const options = { workspace: directory, database: join(directory, 'session.sqlite'), tokenBudget: 6000, outputTokens: 64, system: 'Audit the evidence.' };
    const compose = async () => {
        const extensions = (await defaultAgentExtensions(options)).filter(extension => !extension.roles?.provider);
        return createHarness().compose({ extensions: [...extensions, { id: 'provider.test', version: '1', apiVersion: 1, roles: {
            provider: () => ({ structured: async () => { throw new Error('unused'); }, turn: async request => {
                if (/^(Maintain a concise working checkpoint|Repair a rejected working checkpoint)/.test(request.system ?? '')) {
                    drafts++;
                    return { message: { role: 'assistant', content: 'Inspections recorded. Security verification remains unfinished; original evidence is in callId source-call.' }, stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } };
                }
                tasks++;
                expect(request.messages.some(message => message.content.startsWith('Working checkpoint'))).toBe(true);
                expect(request.tools?.some(tool => tool.name === 'read_tool_result')).toBe(true);
                if (tasks === 1 || tasks === 3) return { message: { role: 'assistant', content: '', toolCalls: [{ id: `recover-source-${tasks}`, name: 'read_tool_result', args: { callId: 'source-call' } }] }, stopReason: 'tool_use', usage: { inputTokens: 100, outputTokens: 20 } };
                expect(request.messages.some(message => message.role === 'tool_result' && message.content.includes(source))).toBe(true);
                return { message: { role: 'assistant', content: 'Release blocked; security verification is unfinished.' }, stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } };
            } }),
        } }] });
    };
    try {
        active = await compose();
        let record = await active.create();
        record = await active.replaceMessages(record.id, record.revision, [
            { role: 'user', content: 'Release only after all verification passes.' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'source-call', name: 'fs_read', args: { path: 'evidence.txt' } }] },
            { role: 'tool_result', toolCallId: 'source-call', content: source },
            ...Array.from({ length: 140 }, (_, index) => ({ role: 'assistant' as const, content: `Observation ${index}: ${'evidence '.repeat(28)}` })),
        ]);
        await active.submit(record.id, 'Continue', { commandId: 'first' });
        const saved = await active.wait(record.id);
        expect(saved.error).toBeUndefined();
        expect(saved.status).toBe('idle');
        expect(drafts).toBeGreaterThan(0);
        expect(saved.messages.slice(0, record.messages.length)).toEqual(record.messages);
        expect((saved.contextState as CheckpointContextState).checkpoint?.through).toBeGreaterThan(2);
        await active.close();
        active = await compose();
        expect((await active.get(record.id)).contextState).toEqual(saved.contextState);
        await active.submit(record.id, 'Confirm the result', { commandId: 'second' });
        const reopened = await active.wait(record.id);
        expect(reopened.error).toBeUndefined();
        expect(reopened.messages.at(-1)?.content).toContain('Release blocked');
        expect(reopened.messages[2].content).toBe(source);
        expect(reopened.operations.filter(operation => operation.kind === 'tool' && operation.name === 'read_tool_result')).toHaveLength(2);
    } finally { await active?.close(); await rm(directory, { recursive: true, force: true }); }
});


it('replaces generated checkpoints with direct context selection without driver changes', async () => {
    let calls = 0;
    const { client, record } = await setup(request => {
        calls++;
        expect(request.system).toBe('Complete the audit.');
        expect(request.messages.some(m => m.content.startsWith('Working checkpoint'))).toBe(false);
        expect(request.messages.some(m => m.content.includes('security verification'))).toBe(true);
        expect(request.messages.some(m => m.content.includes('Do not release'))).toBe(true);
        return 'Verification remains unfinished.';
    }, 20, { async prepare(input, execution) {
        const step = await referenceContextLifecycle().prepare(input, execution);
        return { ...step, reduce: () => ({ state: { observed: true }, decision: 'recorded with task receipt' }) };
    } });
    await client.submit(record.id, 'Continue', { commandId: 'direct' });
    const saved = await client.wait(record.id);
    expect(saved.status).toBe('idle');
    expect(calls).toBe(1);
    expect(saved.contextState).toEqual({ observed: true });
    expect(saved.messages.slice(0, record.messages.length)).toEqual(record.messages);
    expect((await client.events(record.id)).filter(e => e.type === 'model.intent')).toHaveLength(1);
});

it('commits provider usage and receipt even when a lifecycle reducer throws', async () => {
    const { client, record } = await setup(() => 'complete derived response', 20, {
        async prepare(input, execution) {
            return { kind: 'maintenance', prepared: await execution.prepareModel({ messages: [], system: 'derive', maxTokens: 64 }),
                metadata: { purpose: 'test' }, reduce() { throw new Error('Reducer failed'); } };
        },
    });
    await client.submit(record.id, 'Continue', { commandId: 'bad-reducer' });
    const saved = await client.wait(record.id);
    expect(saved.status).toBe('failed');
    expect(saved.error).toBe('Reducer failed');
    expect(saved.usage.inputTokens).toBe(100);
    expect(saved.operations.at(-1)?.status).toBe('completed');
    expect(saved.contextState).toBeUndefined();
    expect(saved.messages.slice(0, record.messages.length)).toEqual(record.messages);
    expect((await client.events(record.id)).some(e => e.type === 'model.completed')).toBe(true);
});

it('uses fitting checkpoints above the character target without repair through the local host', async () => {
    const draft = 'x'.repeat(8591);
    let maintenance = 0, tasks = 0;
    const { client, record } = await setup(request => {
        expect(request.system).not.toMatch(/^Repair/);
        if (request.system?.startsWith('Maintain a concise')) { maintenance++; return draft; }
        tasks++;
        expect(request.messages.some(m => m.content.endsWith(draft))).toBe(true);
        return 'done';
    });
    await client.submit(record.id, 'Continue', { commandId: 'continue' });
    const saved = await client.wait(record.id);
    expect(saved.status).toBe('idle');
    expect(tasks).toBe(1);
    expect(maintenance).toBeGreaterThan(0);
    expect(saved.usage.inputTokens).toBe((maintenance + tasks) * 100);
    expect((saved.contextState as CheckpointContextState).checkpoint?.text).toBe(draft);
    expect((saved.contextState as CheckpointContextState).candidate).toBeUndefined();
    expect(saved.messages.slice(0, record.messages.length)).toEqual(record.messages);
    const events = await client.events(record.id);
    const task = events.find(e => e.type === 'model.intent' && (e.data as { purpose?: string }).purpose === 'task')!;
    expect(task.data).toHaveProperty('contextMetadata.checkpointAccepted');
});


it('persists structured maintenance as state without dispatching its schema call', async () => {
    const lifecycle = checkpointContextLifecycle({ maxTokens: 64, triggerRatio: 0.8, format: {
        instructions: 'Return checkpoint_state with remaining work.',
        tools: [{ name: 'checkpoint_state', description: '', parameters: { type: 'object', properties: { remaining: { type: 'string' } }, required: ['remaining'], additionalProperties: false } }],
        decode(response) {
            const calls = response.message.toolCalls ?? [];
            return calls.length === 1 && calls[0].name === 'checkpoint_state' && typeof calls[0].args.remaining === 'string'
                ? { ok: true, text: JSON.stringify(calls[0].args) } : { ok: false, reason: 'invalid_format' };
        },
    } });
    const { client, record } = await setup(request => {
        if (request.tools?.some(tool => tool.name === 'checkpoint_state')) return {
            message: { role: 'assistant', content: '', toolCalls: [{ id: 'state', name: 'checkpoint_state', args: { remaining: 'Security verification.' } }] },
            stopReason: 'tool_use', usage: { inputTokens: 100, outputTokens: 20 },
        };
        expect(request.messages.some(message => message.content.includes('"remaining":"Security verification."'))).toBe(true);
        return 'Security verification remains unfinished.';
    }, 20, lifecycle);
    await client.submit(record.id, 'Continue', { commandId: 'structured' });
    const saved = await client.wait(record.id);
    expect(saved.status, saved.error).toBe('idle');
    expect(JSON.parse((saved.contextState as CheckpointContextState).checkpoint!.text)).toEqual({ remaining: 'Security verification.' });
    expect(saved.messages.slice(0, record.messages.length)).toEqual(record.messages);
    expect(saved.messages.some(message => message.role === 'assistant' && message.toolCalls?.some(call => call.name === 'checkpoint_state'))).toBe(false);
    const events = await client.events(record.id);
    expect(events.some(event => event.type === 'tool.intent')).toBe(false);
    expect(events.filter(event => event.type === 'model.completed')).toHaveLength(2);
    expect(saved.usage.inputTokens).toBe(200);
});
