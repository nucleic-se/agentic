import { afterEach, expect, it } from 'vitest';
import { createHarness } from './host.js';
import { MemorySessionStore } from './stores.js';
import { budgetedContext, conversationalLoop } from './defaults.js';
import type { SessionClient } from './types.js';
import type { TurnRequest } from '../../contracts/llm.js';

const clients: SessionClient[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.close(); });
async function setup(turn: (request: TurnRequest) => string, maxModelCalls = 20) {
    const client = await createHarness().compose({ limits: { maxModelCalls }, extensions: [{ id: 'continuity.test', version: '1', apiVersion: 1, roles: {
        store: () => new MemorySessionStore(),
        loop: () => conversationalLoop({ maxTokens: 64, checkpoint: { maxTokens: 64, triggerRatio: 0.8 } }),
        context: () => budgetedContext('Complete the audit.', 3000),
        provider: () => ({ turn: async request => ({ message: { role: 'assistant', content: turn(request) }, stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } }), structured: async () => { throw new Error('unused'); } }),
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
            expect(input.output.maxCharacters).toBe(8000);
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
    });
    await client.submit(record.id, 'Continue', { commandId: 'continue' });
    const saved = await client.wait(record.id);
    expect(saved.status).toBe(rejectTwice ? 'failed' : 'idle');
    expect(saved.messages.slice(0, record.messages.length)).toEqual(record.messages);
    expect(saved.messages.some(m => m.content === 'x'.repeat(8591))).toBe(false);
    expect(saved.usage.inputTokens).toBe(saved.operations.length * 100);
    const events = await client.events(record.id);
    const decisions = events.map(event => (event.data as { checkpointDecision?: unknown } | undefined)?.checkpointDecision).filter(Boolean);
    expect(decisions[0]).toEqual({ accepted: false, reason: 'too_large', attempt: 1 });
    if (rejectTwice) {
        expect(drafts).toBe(2);
        expect(saved.checkpoint).toBeUndefined();
        expect(saved.error).toContain('after two attempts');
    } else {
        expect(saved.checkpoint?.through).toBeGreaterThan(0);
        expect(saved.checkpointRejection).toBeUndefined();
        expect(saved.messages.at(-1)?.content).toBe('done');
        const reset = await client.replaceMessages(saved.id, saved.revision, saved.messages);
        expect(reset.checkpoint).toBeUndefined();
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
    expect(saved.checkpoint?.through).toBeGreaterThan(0);
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
        expect(saved.checkpoint?.through).toBeGreaterThan(2);
        await active.close();
        active = await compose();
        expect((await active.get(record.id)).checkpoint).toEqual(saved.checkpoint);
        await active.submit(record.id, 'Confirm the result', { commandId: 'second' });
        const reopened = await active.wait(record.id);
        expect(reopened.error).toBeUndefined();
        expect(reopened.messages.at(-1)?.content).toContain('Release blocked');
        expect(reopened.messages[2].content).toBe(source);
        expect(reopened.operations.filter(operation => operation.kind === 'tool' && operation.name === 'read_tool_result')).toHaveLength(2);
    } finally { await active?.close(); await rm(directory, { recursive: true, force: true }); }
});
