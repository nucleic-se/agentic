import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHarness } from './host.js';
import { createSqliteSessionStore } from './stores.js';
import { conversationalLoop, fullHistoryContext } from './defaults.js';
import type { Extension, SessionClient } from './types.js';
import type { ILLMProvider, TurnResponse } from '../../contracts/llm.js';
import type { IValidatedToolRuntime } from '../../contracts/tool-runtime.js';

const directories: string[] = [];
const clients: SessionClient[] = [];
afterEach(async () => {
    await Promise.all(clients.splice(0).map(client => client.close()));
    await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function databasePath() {
    const dir = await mkdtemp(join(tmpdir(), 'agentic-host-persistence-'));
    directories.push(dir); return join(dir, 'sessions.sqlite');
}
const usage = { inputTokens: 3, outputTokens: 2 };
const proposal: TurnResponse = { message: { role: 'assistant', content: 'Writing', toolCalls: [{ id: 'write-1', name: 'write', args: { content: 'written once' } }] }, stopReason: 'tool_use', usage };
const answer: TurnResponse = { message: { role: 'assistant', content: 'Finished' }, stopReason: 'end_turn', usage };

async function compose(path: string, responses: TurnResponse[]) {
    let index = 0;
    const provider: ILLMProvider = {
        turn: vi.fn(async () => structuredClone(responses[index++] ?? answer)),
        structured: async () => { throw new Error('unused'); }, embed: async () => [],
    };
    const tools: IValidatedToolRuntime = {
        tools: () => [], validate: (_name, args) => ({ ok: true, args }),
        call: vi.fn(async () => ({ ok: true, content: 'written once' })),
    };
    const extensions: Extension[] = [{
        id: 'persistent-test-agent', version: '1', apiVersion: 1,
        roles: {
            store: () => createSqliteSessionStore(path), provider: () => provider,
            tools: () => tools, policy: () => ({ evaluate: async () => ({ kind: 'allow' as const }) }),
            loop: () => conversationalLoop(), context: () => fullHistoryContext(),
        },
    }];
    const client = await createHarness().compose({ extensions }); clients.push(client);
    return { client, provider, tools };
}

describe('SQLite harness integration', () => {
    it('reopens committed history and resumes without repeating completed tools or accepted input', async () => {
        const path = await databasePath();
        const first = await compose(path, [proposal, answer]);
        const session = await first.client.create(), commandId = randomUUID();
        await first.client.submit(session.id, 'Write once', { commandId });
        await vi.waitFor(async () => expect((await first.client.events(session.id)).some(event => event.type === 'run.completed')).toBe(true));
        const before = await first.client.get(session.id), events = await first.client.events(session.id);
        expect(before.messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool_result', 'assistant']);
        expect(first.tools.call).toHaveBeenCalledOnce();
        expect(before.operations.every(operation => operation.status === 'completed')).toBe(true);
        await first.client.close();

        const second = await compose(path, [{ ...answer, message: { role: 'assistant', content: 'Continued' } }]);
        expect(await second.client.get(session.id)).toEqual(before);
        expect(await second.client.events(session.id)).toEqual(events);
        expect(second.provider.turn).not.toHaveBeenCalled();
        expect(second.tools.call).not.toHaveBeenCalled();
        await second.client.submit(session.id, 'Write once', { commandId });
        expect((await second.client.get(session.id)).messages).toEqual(before.messages);
        expect(second.provider.turn).not.toHaveBeenCalled();

        await second.client.resume(session.id);
        await vi.waitFor(async () => expect((await second.client.events(session.id)).filter(event => event.type === 'run.completed')).toHaveLength(2));
        const after = await second.client.get(session.id);
        expect(second.provider.turn).toHaveBeenCalledOnce();
        expect(second.provider.turn).toHaveBeenCalledWith(expect.objectContaining({ messages: before.messages }), expect.anything());
        expect(second.tools.call).not.toHaveBeenCalled();
        expect(after.messages).toEqual([...before.messages, { role: 'assistant', content: 'Continued' }]);
        expect(after.operations.filter(operation => operation.kind === 'tool')).toHaveLength(1);
        expect(after.commandIds).toEqual([commandId]);
        expect(after.queue).toEqual([]);
        expect(after.usage).toEqual({ inputTokens: 9, outputTokens: 6 });
        const laterEvents = await second.client.events(session.id, before.revision);
        expect(laterEvents.every(event => event.sequence > before.revision)).toBe(true);
        expect((await second.client.events(session.id)).slice(0, events.length)).toEqual(events);
    });

    it('recovers a persisted unfinished tool as unknown and refuses to repeat its side effect', async () => {
        const path = await databasePath(), first = await compose(path, [answer]);
        const session = await first.client.create();
        await first.client.close();
        // Persist the same boundary left by an owner killed after tool intent.
        const store = await createSqliteSessionStore(path);
        try {
            await store.commit(session.id, 0, {
                ...session, revision: 1, status: 'running', activeRunId: 'crashed-run',
                messages: [{ role: 'user', content: 'Write once' }, proposal.message],
                operations: [{ id: 'pending-tool', runId: 'crashed-run', kind: 'tool', status: 'intent', name: 'write', input: proposal.message.toolCalls![0].args, createdAt: Date.now() }],
            }, { schemaVersion: 1, id: randomUUID(), sessionId: session.id, runId: 'crashed-run', sequence: 1, type: 'tool.intent', timestamp: Date.now() });
        } finally { await store.close(); }
        const recovered = await compose(path, [answer]);
        const state = await recovered.client.get(session.id);
        expect(state.status).toBe('interrupted');
        expect(state.operations[0].status).toBe('unknown');
        expect(state.messages.at(-1)).toMatchObject({ role: 'tool_result', toolCallId: 'write-1', isError: true });
        expect(state.approvals).toEqual([]);
        await expect(recovered.client.resume(session.id)).rejects.toThrow('Unknown tool');
        expect(recovered.provider.turn).not.toHaveBeenCalled();
        expect(recovered.tools.call).not.toHaveBeenCalled();
        expect((await recovered.client.events(session.id)).at(-1)?.type).toBe('run.recovered');
    });
});
