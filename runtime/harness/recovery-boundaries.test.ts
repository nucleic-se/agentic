import { expect, it } from 'vitest';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteSessionStore, readSqliteSession } from './stores.js';
import { conversationalLoop, TurnLimitError } from './loops.js';
import type { SessionRecord, LoopServices } from './types.js';

it('reads live WAL state without taking ownership, creating a missing database or accepting future schemas', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'read-session-'));
    const path = join(dir, 'sessions.sqlite');
    try {
        await expect(readSqliteSession(path, 'test')).rejects.toThrow();
        await expect(access(path)).rejects.toThrow();
        const store = await createSqliteSessionStore(path);
        try {
            const record: SessionRecord = { id: 'test', revision: 0, title: 'Test', createdAt: 1, updatedAt: 1,
                status: 'idle', messages: [], operations: [], approvals: [], commandIds: [], queue: [],
                usage: { inputTokens: 0, outputTokens: 0 }, composition: 'test' };
            await store.create(record);
            expect(await readSqliteSession(path, 'test')).toEqual(record);
            expect(await readSqliteSession(path, 'missing')).toBeUndefined();
            record.revision++;
            record.messages.push({ role: 'user', content: 'committed in WAL' });
            await store.commit('test', 0, record, { schemaVersion: 1, id: 'event', sessionId: 'test', sequence: 1, timestamp: 1, type: 'test' });
            expect(await readSqliteSession(path, 'test')).toEqual(record);
        } finally { await store.close(); }
        const { openSqlite } = await import('../sqlite.js');
        const db = await openSqlite(path);
        db.exec('PRAGMA user_version=99'); db.close();
        await expect(readSqliteSession(path, 'test')).rejects.toThrow('schema version');
    } finally { await rm(dir, { recursive: true, force: true }); }
});

it('reports typed turn exhaustion without changing the tool protocol', async () => {
    let effects = 0;
    const services = { signal: new AbortController().signal, takeQueued: async () => [], context: async () => ({messages: []}),
        model: { request: async () => ({ message: { role: 'assistant', content: '', toolCalls: [{id:'call',name:'test',args:{}}] }, stopReason:'tool_use', usage:{inputTokens:1,outputTokens:1} }) },
        tools: { executeBatch: async () => { effects++; return []; } },
    } as unknown as LoopServices;
    await expect(conversationalLoop({maxTurns:1}).run(services)).rejects.toMatchObject({ name:'TurnLimitError', maxTurns:1 });
    expect(effects).toBe(1);
    expect(new TurnLimitError(1)).toBeInstanceOf(Error);
});

it('offline reconciliation is revision fenced, redacted and never replays a tool', async () => {
    const { resolveSessionOperation, inspectSessionRecovery } = await import('./resolution.js');
    const dir=await mkdtemp(join(tmpdir(),'resolve-session-'));
    const path=join(dir,'sessions.sqlite');
    const store=await createSqliteSessionStore(path);
    try {
        const record: SessionRecord={id:'test',revision:0,title:'private title',createdAt:1,updatedAt:1,status:'failed',
            messages:[{role:'assistant',content:'',toolCalls:[{id:'call',name:'write',args:{secret:'PRIVATE'}}]},
                {role:'tool_result',toolCallId:'call',content:'Uncertain',isError:true}],
            operations:[{id:'op',kind:'tool',status:'unknown',runId:'run',callId:'call',name:'write',createdAt:1,input:{secret:'PRIVATE'}}],
            approvals:[],queue:[],commandIds:['input'],inputReceipts:[{commandId:'input',contentHash:'hash',metadata:{},status:'interrupted'}],
            usage:{inputTokens:0,outputTokens:0},composition:'composition'};
        await store.create(record);
        const inspection=inspectSessionRecovery(record);
        expect(JSON.stringify(inspection)).not.toContain('PRIVATE');
        expect(inspection.unresolvedTools).toEqual([{id:'op',name:'write',callId:'call',status:'unknown',resolvable:true}]);
        const resolution={expectedRevision:0,evidence:'Verified the saved output externally',result:{ok:true,content:'Confirmed written'}};
        const fixed=await resolveSessionOperation(store,'test','op',resolution);
        expect(fixed.messages).toHaveLength(2);
        expect(fixed.messages[1]).toMatchObject({content:'Confirmed written',isError:false});
        expect(fixed.inputReceipts).toEqual(record.inputReceipts);
        expect(fixed.status).toBe('interrupted');
        await expect(resolveSessionOperation(store,'test','op',resolution)).rejects.toThrow('revision');
        expect((await store.events('test')).map(e=>e.type)).toEqual(['tool.resolved']);
        expect(await readSqliteSession(path,'test')).toEqual(fixed);
    } finally {await store.close();await rm(dir,{recursive:true,force:true});}
});
