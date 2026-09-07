import { expect, it } from 'vitest';
import { SqliteMemoryStore } from '../SqliteMemoryStore.js';
import { memoryToolRuntime } from './memory.js';
import { executeToolBatchDetailed } from '../ToolBatchExecutor.js';

it('uses host identity for evidence and retains exact earlier revisions after correction', async () => {
    const store = await SqliteMemoryStore.open(':memory:', 'workspace');
    try {
        let evidence = 'x'.repeat(4500);
        const runtime = memoryToolRuntime(store, async (sessionId, callId) => {
            expect(sessionId).toBe('host-session'); expect(callId).toBe('source-call');
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
        evidence = 'corrected command';
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
