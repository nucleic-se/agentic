import assert from 'node:assert/strict';
import type { SessionEvent, SessionRecord, SessionStore } from '../harness/types.js';
import type { ConformanceReport } from './provider.js';
export interface SessionStoreFixture {
    /** Fresh empty disposable store, never a production database. */
    store: SessionStore;
    /** Reopen the same storage after the suite closes it; omit for ephemeral stores. */
    reopen?(): Promise<SessionStore>;
    dispose?(): void | Promise<void>;
}
export type SessionStoreFactory = () => SessionStoreFixture | Promise<SessionStoreFixture>;
function record(id: string): SessionRecord {
    return { id, title: id, revision: 0, createdAt: 1, updatedAt: 1, status: 'idle', messages: [{ role: 'user', content: 'original' }],
        operations: [], approvals: [], commandIds: [], queue: [], usage: { inputTokens: 0, outputTokens: 0 }, composition: 'conformance' };
}
function event(sessionId: string, sequence: number, id = `event-${sequence}`): SessionEvent {
    return { schemaVersion: 1, id, sessionId, sequence, type: 'test.changed', timestamp: sequence, data: { value: 'original' } };
}
/** Exercise atomic CAS, snapshot isolation and exclusive event cursors using only public store methods. */
export async function assertSessionStoreConformance(create: SessionStoreFactory): Promise<ConformanceReport> {
    const fixture = await create();
    let store = fixture.store;
    const checks: string[] = [];
    try {
        const original = record('session');
        await store.create(original);
        original.messages[0].content = 'mutated';
        const loaded = (await store.get('session'))!;
        assert.equal(loaded.messages[0].content, 'original');
        loaded.messages[0].content = 'read mutation';
        const listed = await store.list(); listed[0].title = 'list mutation';
        assert.equal('messages' in listed[0], false);
        assert.equal((await store.get('session'))!.title, loaded.title);
        assert.equal((await store.get('session'))!.messages[0].content, 'original');
        await assert.rejects(store.create(record('session')));
        checks.push('create/get/list copy isolation and duplicate rejection');

        const first = { ...record('session'), revision: 1, title: 'first' };
        const firstEvent = event('session', 1);
        await store.commit('session', 0, first, firstEvent);
        first.title = 'mutated'; (firstEvent.data as {value:string}).value = 'mutated';
        assert.equal((await store.get('session'))!.title, 'first');
        assert.equal(((await store.events('session'))[0].data as {value:string}).value, 'original');
        const readEvents = await store.events('session'); (readEvents[0].data as {value:string}).value = 'read mutation';
        assert.equal(((await store.events('session'))[0].data as {value:string}).value, 'original');
        checks.push('commit/event copy isolation');

        const before = await store.get('session');
        await assert.rejects(store.commit('session', 0, { ...record('session'), revision: 1, title: 'stale' }, event('session', 1, 'stale')));
        assert.deepEqual(await store.get('session'), before);
        assert.equal((await store.events('session')).length, 1);
        // Duplicate event insertion fails after the SQLite state update, proving transaction rollback.
        await assert.rejects(store.commit('session', 1, { ...before!, revision: 2, title: 'must roll back' }, event('session', 2, 'event-1')));
        assert.deepEqual(await store.get('session'), before);
        assert.equal((await store.events('session')).length, 1);
        checks.push('stale CAS and event insertion failures are atomic');

        const contenders = ['left', 'right'].map(title => store.commit('session', 1, { ...before!, revision: 2, title }, event('session', 2, title)));
        const settled = await Promise.allSettled(contenders);
        assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1);
        const winner = (await store.get('session'))!;
        assert.equal(winner.revision, 2);
        assert.equal((await store.events('session', 1))[0].id, winner.title);
        checks.push('one concurrent CAS writer wins with matching event');

        await store.commit('session', 2, { ...winner, revision: 3 }, event('session', 3));
        const page1 = await store.events('session', 0, 2), page2 = await store.events('session', page1[1].sequence, 2);
        assert.deepEqual([...page1, ...page2].map(item => item.sequence), [1, 2, 3]);
        assert.deepEqual(await store.events('session', 3, 2), []);
        assert.deepEqual(await store.events('session', 0, 0), []);
        await assert.rejects(store.events('session', -1, 2));
        await store.create({ ...record('second'), updatedAt: 2 });
        assert.deepEqual((await store.list({ limit: 1, offset: 0 })).map(item => item.id), ['second']);
        assert.deepEqual((await store.list({ limit: 1, offset: 1 })).map(item => item.id), ['session']);
        checks.push('exclusive event cursors and bounded stable list pages');

        const saved = await store.get('session'), savedEvents = await store.events('session');
        await store.close();
        await assert.rejects(store.get('session'));
        if (fixture.reopen) {
            store = await fixture.reopen();
            assert.deepEqual(await store.get('session'), saved);
            assert.deepEqual(await store.events('session'), savedEvents);
            checks.push('state and events survive reopening');
        }
        return { checks };
    } finally { try { await store.close(); } finally { await fixture.dispose?.(); } }
}
