import { expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Use the built worker entrypoint; npm test builds before running tests.
import { codingToolRuntime } from '../../dist/runtime/harness/defaults.js';
import { CompositeToolRuntime } from '../../tools/composite.js';
import { executeToolBatch } from '../ToolBatchExecutor.js';

it('accepts an empty shell cwd as the confined workspace root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shell-cwd-'));
    try {
        const runtime = codingToolRuntime(root);
        const result = await runtime.call('shell_run', { command: 'pwd', cwd: '' });
        expect(result).toMatchObject({ ok: true });
        expect(result.content).toContain(root);
        expect(runtime.validate('shell_run', { command: 'pwd', cwd: '..' }).ok).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
});

it('advertises coding limits and byte/line modes from the validation schemas', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tool-contract-'));
    try {
        const runtime = codingToolRuntime(root, { readOnly: true });
        const grep = runtime.tools().find(t => t.name === 'search_grep')!.parameters;
        expect(grep.properties?.max_results).toMatchObject({ minimum: 1, maximum: 100 });
        expect(grep.properties?.context_lines).toMatchObject({ minimum: 0, maximum: 10 });
        expect(grep.additionalProperties).toBe(false);
        for (const [key, maximum] of [['max_results', 100], ['context_lines', 10]] as const) {
            expect(runtime.validate('search_grep', { pattern: 'x', [key]: maximum }).ok).toBe(true);
            expect(runtime.validate('search_grep', { pattern: 'x', [key]: maximum + 1 }).ok).toBe(false);
        }
        const read = runtime.tools().find(t => t.name === 'fs_read')!.parameters;
        expect(read.anyOf).toHaveLength(3);
        expect(runtime.validate('fs_read', { path: 'source', encoding: 'base64', offset: 1 }).ok).toBe(false);
        expect(runtime.validate('fs_read', { path: 'x', offset: 0 }).ok).toBe(false);
        expect(runtime.validate('fs_read', { path: 'x', mode: 'bytes', offset: 0, limit: 16000 }).ok).toBe(true);
        expect(runtime.validate('fs_read', { path: 'x', mode: 'bytes', limit: 16001 }).ok).toBe(false);
        await writeFile(join(root, 'source'), 'needle');
        const search = await runtime.call('search_grep', { path: '', pattern: 'needle', literal: true });
        expect(search.ok, search.content).toBe(true);
        const listing = await runtime.call('fs_list', { path: '' });
        expect(listing.ok, listing.content).toBe(true);
        expect(listing.content).toContain('source');
        expect(runtime.validate('fs_list', { path: '../outside' }).ok).toBe(false);
        expect(runtime.validate('search_grep', { path: '../outside', pattern: 'needle' }).ok).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
});
it('keeps valid coding reads when a sibling search has invalid limits through a composite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'read-batch-'));
    try {
        await writeFile(join(root, 'source'), 'verified source');
        const tools = new CompositeToolRuntime([codingToolRuntime(root, { readOnly: true })]);
        const result = await executeToolBatch([
            { id: 'bad', name: 'search_grep', args: { pattern: 'x', max_results: 150 } },
            { id: 'good', name: 'fs_read', args: { path: 'source' } },
        ], { tools });
        expect(result[0]).toMatchObject({ dispatched: false, status: 'runtime_failure' });
        expect(result[1]).toMatchObject({ dispatched: true, status: 'success' });
        expect(result[1].result?.content).toContain('verified source');
        expect(tools.effectFor('nonexistent')).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
});
