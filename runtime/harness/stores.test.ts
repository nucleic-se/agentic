import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { MemorySessionStore, createSqliteSessionStore } from './stores.js';
import type { SessionEvent, SessionRecord, SessionStore } from './types.js';

const paths: string[] = [];
const stores: SessionStore[] = [];
afterEach(async () => {
    await Promise.all(stores.splice(0).map(store => store.close()));
    await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function path() { const dir = await mkdtemp(join(tmpdir(), 'agentic-session-')); paths.push(dir); return join(dir, 'sessions.sqlite'); }
function record(): SessionRecord {
    return { id: 'session', title: 'test', revision: 0, createdAt: 1, updatedAt: 1, status: 'idle', messages: [], operations: [], approvals: [], commandIds: [], queue: [], usage: { inputTokens: 0, outputTokens: 0 }, composition: 'test' };
}
function event(sequence: number): SessionEvent { return { schemaVersion: 1, id: `event-${sequence}`, sessionId: 'session', sequence, type: 'changed', timestamp: sequence }; }
for (const backend of ['memory', 'sqlite']) {
    describe(`${backend} session store conformance`, () => {
        async function open() { const store = backend === 'memory' ? new MemorySessionStore() : await createSqliteSessionStore(await path()); stores.push(store); return store; }
        it('isolates state and events, filters cursors and rejects duplicates', async () => {
            const store = await open(), initial = record();
            await store.create(initial); initial.title = 'mutated';
            expect((await store.get(initial.id))?.title).toBe('test');
            await expect(store.create(record())).rejects.toThrow();
            const next = { ...record(), revision: 1 }, change = event(1);
            await store.commit(next.id, 0, next, change);
            next.title = 'changed'; change.type = 'mutated';
            const read = (await store.get(next.id))!; read.messages.push({ role: 'user', content: 'mutated' });
            const listed = await store.list(); listed[0].title = 'mutated';
            const events = await store.events(next.id); events[0].type = 'mutated';
            expect((await store.get(next.id))?.messages).toEqual([]);
            expect((await store.get(next.id))?.title).toBe('test');
            expect((await store.events(next.id))[0].type).toBe('changed');
            expect(await store.events(next.id, 1)).toEqual([]);
            expect(await store.get('missing')).toBeUndefined();
        });
        it('atomically rejects stale commits and duplicate events', async () => {
            const store = await open(); await store.create(record());
            await store.commit('session', 0, { ...record(), revision: 1 }, event(1));
            await expect(store.commit('session', 0, { ...record(), revision: 1, title: 'stale' }, event(1))).rejects.toThrow('revision conflict');
            await expect(store.commit('session', 1, { ...record(), revision: 2, title: 'bad' }, { ...event(2), id: 'event-1' })).rejects.toThrow();
            expect((await store.get('session'))?.revision).toBe(1);
            expect(await store.events('session')).toHaveLength(1);
        });
        it('reads bounded pages consistently without skipping event cursors', async () => {
            const store = await open();
            for (let i = 0; i < 4; i++) await store.create({ ...record(), id: `s${i}`, updatedAt: i });
            expect((await store.list({ limit: 2 })).map(r => r.id)).toEqual(['s3','s2']);
            expect((await store.list({ limit: 2, offset: 2 })).map(r => r.id)).toEqual(['s1','s0']);
            for (const id of ['a','_','A']) await store.create({ ...record(), id, updatedAt: 9 });
            expect((await store.list({ limit: 3 })).map(r => r.id)).toEqual(['A','_','a']);
            expect(await store.list({ limit: 0 })).toEqual([]);
            await expect(store.list({ limit: -1 })).rejects.toThrow();
            await store.create(record());
            for (let revision = 1; revision <= 3; revision++) await store.commit('session', revision - 1, { ...record(), revision }, event(revision));
            expect((await store.events('session', 0, 2)).map(e => e.sequence)).toEqual([1,2]);
            expect((await store.events('session', 2, 2)).map(e => e.sequence)).toEqual([3]);
            expect(await store.events('session', 0, 0)).toEqual([]);
            await expect(store.events('session', -1, 2)).rejects.toThrow();
        });
        it('rejects invalid revisions and use after close', async () => {
            const store = await open();
            await expect(store.create({ ...record(), revision: 5 })).rejects.toThrow();
            await store.create(record());
            await expect(store.commit('session', 0, { ...record(), revision: 1 }, event(2))).rejects.toThrow('Invalid session commit');
            await expect(store.commit('other', 0, { ...record(), revision: 1 }, event(1))).rejects.toThrow();
            await store.close(); await store.close();
            await expect(store.get('session')).rejects.toThrow('closed');
        });
    });
}
describe('SQLite durability and ownership', () => {
    it('recovers a lock whose local owner process has exited', async () => {
        const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
        expect(child.status).toBe(0);
        const file = await path(); await mkdir(`${file}.lock`);
        await writeFile(`${file}.lock/owner.json`, JSON.stringify({ pid: Number(child.stdout), hostname: hostname(), token: 'stale' }));
        const store = await createSqliteSessionStore(file); stores.push(store);
        await store.create(record()); expect(await store.list()).toHaveLength(1);
    });
    it('rejects future schema versions and releases ownership', async () => {
        const file = await path(), moduleName = 'node:sqlite';
        const { DatabaseSync } = await import(moduleName);
        const db = new DatabaseSync(file); db.exec('PRAGMA user_version=999'); db.close();
        await expect(createSqliteSessionStore(file)).rejects.toThrow('schema version 999');
        await expect(createSqliteSessionStore(file)).rejects.toThrow('schema version 999');
    });
    it('rejects competing owners and preserves state/events after reopening', async () => {
        const file = await path(), first = await createSqliteSessionStore(file); stores.push(first);
        await first.create(record()); await first.commit('session', 0, { ...record(), revision: 1 }, event(1));
        await expect(createSqliteSessionStore(file)).rejects.toThrow('live owner');
        await first.close();
        const reopened = await createSqliteSessionStore(file); stores.push(reopened);
        expect((await reopened.get('session'))?.revision).toBe(1);
        expect(await reopened.events('session')).toEqual([event(1)]);
    });
    it('rejects foreign owners without deleting their lock', async () => {
        const file = await path(); await mkdir(`${file}.lock`);
        await writeFile(`${file}.lock/owner.json`, JSON.stringify({ pid: process.pid, hostname: `${hostname()}-foreign`, token: 'foreign' }));
        await expect(createSqliteSessionStore(file)).rejects.toThrow('foreign');
        await expect(createSqliteSessionStore(file)).rejects.toThrow('foreign');
    });
    it('cleans up ownership after initialization fails', async () => {
        const file = await path(); await writeFile(file, 'not a database');
        await expect(createSqliteSessionStore(file)).rejects.toThrow();
        await rm(file);
        const store = await createSqliteSessionStore(file); stores.push(store);
        await store.create(record()); expect(await store.list()).toHaveLength(1);
    });
});
