import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarness } from './host.js';
import { createSqliteSessionStore } from './stores.js';
import { conversationalLoop, fullHistoryContext } from './defaults.js';
import { sessionNoteSource } from './memory.js';

it.each([true, false])('retains exact resolved evidence across transcript replacement and reopen (ok=%s)', async ok => {
    const dir = await mkdtemp(join(tmpdir(), 'resolved-source-'));
    let dispatches = 0;
    const open = () => createHarness().compose({ extensions: [{ id: 'resolution-test', version: '1', apiVersion: 1, roles: {
        store: () => createSqliteSessionStore(join(dir, 'session.sqlite')),
        loop: () => conversationalLoop(), context: () => fullHistoryContext(),
        provider: () => ({ structured: async () => { throw new Error('unused'); }, turn: async () => ({
            message: { role: 'assistant', content: '', toolCalls: [{ id: 'effect', name: 'write', args: {} }] },
            stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 },
        }) }),
        tools: () => ({ tools: () => [], validate: (_name, args) => ({ ok: true, args }), call: async () => {
            dispatches++; return { ok: false, content: 'Uncertain original receipt', errorKind: 'unknown' };
        } }),
        policy: () => ({ evaluate: async () => ({ kind: 'allow' }) }),
    } }] });
    let client: Awaited<ReturnType<typeof open>> | undefined;
    try {
        client = await open();
        const session = await client.create();
        await client.submit(session.id, 'Record effect.', { commandId: 'start' });
        const blocked = await client.wait(session.id), operation = blocked.operations.find(op => op.kind === 'tool')!;
        const query = { sessionId: session.id, callId: 'effect' };
        await expect(sessionNoteSource(client)(query)).rejects.toThrow('no known tool receipt');
        const content = 'Verified evidence\n' + 'x'.repeat(18000) + '\nexact tail';
        const resolution = { expectedRevision: blocked.revision, evidence: 'Independent receipt inspected', result: { ok, content } };
        const resolved = await client.resolveOperation(session.id, operation.id, resolution);
        expect(resolved.operations.find(op => op.id === operation.id)).toMatchObject({ output: operation.output, resolution });
        const source = await sessionNoteSource(client)(query);
        expect(source).toMatchObject({ content, isError: !ok });
        await client.replaceMessages(session.id, resolved.revision, [{ role: 'user', content: 'New context view.' }]);
        await client.close(); client = undefined;
        client = await open();
        expect(await sessionNoteSource(client)({ reference: source.reference })).toEqual(source);
        expect((await client.events(session.id)).some(event => event.type === 'tool.resolved')).toBe(true);
        expect(dispatches).toBe(1);
    } finally { await client?.close(); await rm(dir, { recursive: true, force: true }); }
});
