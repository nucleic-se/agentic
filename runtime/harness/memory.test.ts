import { expect, it } from 'vitest';
import { SqliteMemoryStore } from '../SqliteMemoryStore.js';
import { memoryToolRuntime } from './memory.js';
import { executeToolBatchDetailed } from '../ToolBatchExecutor.js';

it('uses host identity for evidence and retains exact earlier revisions after correction', async () => {
    const store = await SqliteMemoryStore.open(':memory:', 'workspace');
    try {
        let evidence = 'x'.repeat(4500);
        const runtime = memoryToolRuntime(store, async query => {
            if ('sessionId' in query) expect(query).toEqual({ sessionId: 'host-session', callId: 'source-call' });
            else expect(query.reference).toBe('session/host-session/operation/1');
            return { reference: 'session/host-session/operation/1', content: evidence, isError: false };
        });
        expect(runtime.tools().map(tool => tool.name)).toEqual(['memory_search', 'memory_read', 'memory_save']);
        const save = { key: 'verification', note: 'use check', callId: 'source-call', offset: 500 };
        expect((await runtime.call('memory_save', save)).errorKind).toBe('policy');
        expect((await runtime.call('memory_save', { ...save, sessionId: 'forged' })).errorKind).toBe('validation');
        const result = await executeToolBatchDetailed([{ id: 'save', name: 'memory_save', args: save }], { tools: runtime, sessionId: 'host-session' });
        expect(result.executions[0].status).toBe('success');
        const first = JSON.parse(result.executions[0].result!.content);
        const source = JSON.parse((await runtime.call('memory_read', { id: first.id, version: 1 })).content);
        expect(source.value.evidence).toMatchObject({ content: 'x'.repeat(4000), offset: 500, totalCharacters: 4500 });
        const page = JSON.parse((await runtime.call('memory_read', { id: first.id, version: 1, sourceOffset: 0 })).content);
        expect(page).toMatchObject({ content: 'x'.repeat(4000), nextOffset: 4000, eof: false });
        const tail = JSON.parse((await runtime.call('memory_read', { id: first.id, version: 1, sourceOffset: page.nextOffset })).content);
        expect(tail).toMatchObject({ content: 'x'.repeat(500), nextOffset: 4500, eof: true });
        expect((await runtime.call('memory_read', { id: first.id, version: 1, sourceOffset: 4501 })).errorKind).toBe('validation');
        evidence = 'corrected command';
        expect((await runtime.call('memory_read', { id: first.id, version: 1, sourceOffset: 0 })).content).toContain('differs from the saved fingerprint');
        const update = { ...save, offset: 0, note: 'use verify', id: first.id, expectedVersion: 1 };
        expect((await runtime.call('memory_save', update, { sessionId: 'host-session' })).ok).toBe(true);
        expect((await runtime.call('memory_save', update, { sessionId: 'host-session' })).ok).toBe(false);
        expect(JSON.parse((await runtime.call('memory_read', { id: first.id, version: 1 })).content)).toEqual(source);
        const hits = JSON.parse((await runtime.call('memory_search', { text: 'verification' })).content);
        expect(hits).toMatchObject([{ id: first.id, version: 2, note: 'use verify' }]);
        expect(hits[0].evidence).toBeUndefined();
    } finally { await store.close(); }
});

it('does not store a note if its source is missing or reading is cancelled', async () => {
    const store = await SqliteMemoryStore.open(':memory:', 'workspace');
    try {
        const runtime = memoryToolRuntime(store, async () => { throw new Error('Receipt missing'); });
        const args = { key: 'x', note: 'unsupported', callId: 'missing' };
        expect((await runtime.call('memory_save', args, { sessionId: 'session' })).ok).toBe(false);
        expect((await runtime.call('memory_save', args, { sessionId: 'session', signal: AbortSignal.abort() })).errorKind).toBe('cancelled');
        expect(await store.query({ limit: 10 })).toEqual([]);
    } finally { await store.close(); }
});

it('keeps captured evidence readable when the source archive is unavailable', async () => {
    const store = await SqliteMemoryStore.open(':memory:', 'workspace');
    try {
        const runtime = memoryToolRuntime(store, async query => {
            if ('reference' in query) throw new Error('Original archive is unavailable');
            return { reference: 'original', content: 'recorded evidence', isError: false };
        });
        const saved = JSON.parse((await runtime.call('memory_save', { key: 'fact', note: 'historical', callId: 'call' }, { sessionId: 'session' })).content);
        const request = { id: saved.id, version: 1 };
        expect((await runtime.call('memory_read', { ...request, sourceOffset: 0 })).content).toContain('archive is unavailable');
        const note = JSON.parse((await runtime.call('memory_read', request)).content);
        expect(note.value.evidence.content).toBe('recorded evidence');
        expect((await runtime.call('memory_read', { ...request, reference: 'model-invented-source' })).errorKind).toBe('validation');
    } finally { await store.close(); }
});
