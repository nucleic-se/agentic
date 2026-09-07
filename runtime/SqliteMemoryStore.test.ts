import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteMemoryStore } from './SqliteMemoryStore.js';
import { openSqlite } from './sqlite.js';

const stores: SqliteMemoryStore[] = [], roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function open(path: string, options = {}) { const store = await SqliteMemoryStore.open(path, 'workspace-a', options); stores.push(store); return store; }
const note = (key: string, value: unknown) => ({ type: 'semantic' as const, key, value, confidence: 1, source: 'session:first/message:4', tags: ['project'] });

it('retains exact source-linked revisions across reopen and rejects stale concurrent updates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentic-memory-')); roots.push(root);
    const path = join(root, 'memory.sqlite'), first = await open(path);
    const written = await first.write(note('build', { command: 'npm test', revision: 1 }));
    await first.close(); stores.splice(stores.indexOf(first), 1);
    const a = await open(path), b = await open(path);
    const updated = await a.update(written.id, { value: { command: 'node --test', revision: 2 }, source: 'session:second/message:8' }, written.version);
    await expect(b.update(written.id, { value: 'stale overwrite' }, written.version)).rejects.toThrow('version conflict');
    expect(await b.get(written.id)).toEqual(updated);
    expect(await b.getVersion(written.id, 1)).toEqual(written);
    expect((await b.query({ text: 'BUILD node', limit: 5 }))[0]).toEqual(updated);
    expect(await b.query({ text: 'npm', limit: 5 })).toEqual([]);
    await expect(a.update(written.id, { key: 'changed identity' } as never, updated.version)).rejects.toThrow('patch field');
    expect(await a.get(written.id)).toEqual(updated);
    await expect(SqliteMemoryStore.open(path, 'different-workspace')).rejects.toThrow('scope mismatch');
});

it('applies lexical, type, tag and value budgets without returning mutable storage', async () => {
    const store = await open(':memory:');
    const large = await store.write(note('Ångström build', 'x'.repeat(1000)));
    const small = await store.write(note('Ångström build', 'ok'));
    const hits = await store.query({ text: 'ÅNGSTRÖM BUILD', tags: ['project'], types: ['semantic'], limit: 2, tokenBudget: 3 });
    expect(hits.map(item => item.id)).toEqual([small.id]);
    hits[0].tags.push('mutation');
    expect((await store.get(small.id))!.tags).toEqual(['project']);
    expect(await store.query({ text: '%', limit: 2 })).toEqual([]);
    expect(await store.query({ limit: 0 })).toEqual([]);
    expect(await store.query({ tags: ['absent'], limit: 5 })).toEqual([]);
    expect(await store.query({ types: ['working'], limit: 5 })).toEqual([]);
    await expect(store.query({ limit: -1 })).rejects.toThrow();
    await store.delete(large.id); expect(await store.getVersion(large.id, 1)).toBeUndefined();
});

it('enforces atomic capacity and preserves expired evidence outside active recall', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const store = await open(':memory:', { maxItems: 1, maxVersions: 2 });
    const written = await store.write({ ...note('temporary', 'first'), ttlDays: 1 / 86400 });
    await expect(store.write(note('overflow', 'second'))).rejects.toThrow('item capacity');
    clock.mockReturnValue(2001);
    expect(await store.get(written.id)).toBeUndefined();
    expect(await store.query({ limit: 10 })).toEqual([]);
    expect(await store.evictExpired()).toBe(1);
    expect(await store.getVersion(written.id, 1)).toEqual(written);
    const second = await store.write(note('second', 'retained'));
    await expect(store.update(second.id, { value: 'would exceed history capacity' }, 1)).rejects.toThrow('revision capacity');
    expect(await store.get(second.id)).toEqual(second);
    expect(await store.getVersion(second.id, 2)).toBeUndefined();
});

it('rejects invalid or oversized notes before persisting a revision', async () => {
    const store = await open(':memory:');
    for (const input of [{ ...note('bad', ''), confidence: NaN }, note('', 'value'), note('large', 'x'.repeat(8001)), note('missing', undefined),
        note('lossy-number', NaN), note('lossy-object', { missing: undefined }), note('lossy-date', new Date())])
        await expect(store.write(input)).rejects.toThrow();
    expect(await store.query({ limit: 10 })).toEqual([]);
    await expect(store.write({ ...note('extra', 'ok'), hidden: 'unbounded metadata' } as never)).rejects.toThrow('item field');
});

it('rejects an unsupported durable schema', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentic-memory-')); roots.push(root);
    const path = join(root, 'memory.sqlite'), store = await open(path);
    await store.close(); stores.splice(stores.indexOf(store), 1);
    const db = await openSqlite(path);
    db.exec('UPDATE memory_scope SET schema_version=2');
    db.close();
    await expect(open(path)).rejects.toThrow('Unsupported memory schema');
});
