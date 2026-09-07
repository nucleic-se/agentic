import { expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultAgentExtensions } from './preset.js';
import { compositionFingerprint } from './composition.js';

it('configures source pages without replacing the default tool composition', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agentic-preset-pages-'));
    try {
        await writeFile(join(workspace, 'source.ts'), Array.from({ length: 200 }, (_, i) => `line ${i}: ${'x'.repeat(50)}`).join('\n'));
        const defaults = await defaultAgentExtensions({ workspace });
        const larger = await defaultAgentExtensions({ workspace, textPageBytes: 16000 });
        expect(compositionFingerprint(defaults)).not.toBe(compositionFingerprint(larger));
        expect(compositionFingerprint(defaults)).toBe(compositionFingerprint(await defaultAgentExtensions({ workspace, textPageBytes: 4000 })));
        const small = await defaults.find(e => e.id === 'tools.coding')!.roles!.tools!();
        const large = await larger.find(e => e.id === 'tools.coding')!.roles!.tools!();
        expect(large.tools().map(t => t.name)).toEqual(small.tools().map(t => t.name));
        expect(await small.call('fs_read', { path: 'source.ts' })).toMatchObject({ ok: true, data: { truncated: true } });
        expect(await large.call('fs_read', { path: 'source.ts' })).toMatchObject({ ok: true, data: { linesReturned: 200, truncated: false } });
        expect((await large.call('fs_read', { path: '../outside' })).ok).toBe(false);
    } finally { await rm(workspace, { recursive: true, force: true }); }
});

it('keeps oversized recent tool evidence recoverable through the default archive', async () => {
    const { createHarness } = await import('./host.js');
    const workspace = await mkdtemp(join(tmpdir(), 'agentic-preset-archive-'));
    let client: Awaited<ReturnType<ReturnType<typeof createHarness>['compose']>> | undefined;
    try {
        await writeFile(join(workspace, 'source.ts'), Array.from({ length: 200 }, (_, i) => `evidence ${i}: ${'x'.repeat(50)}`).join('\n'));
        const extensions = (await defaultAgentExtensions({ workspace, tokenBudget: 3500, outputTokens: 100, textPageBytes: 16000, readOnly: true }))
            .filter(e => !e.roles?.provider && !e.roles?.loop);
        const { conversationalLoop } = await import('./defaults.js');
        let turns = 0;
        client = await createHarness().compose({ extensions: [...extensions, { id: 'test.model', version: '1', apiVersion: 1, roles: {
            loop: () => conversationalLoop({ maxTokens: 100 }),
            provider: () => ({ structured: async () => { throw new Error('unused'); }, turn: async request => {
                turns++;
                if (turns === 1) return { message: { role: 'assistant', content: '', toolCalls: [{ id: 'source', name: 'fs_read', args: { path: 'source.ts' } }] }, stopReason: 'tool_use', usage: { inputTokens: 100, outputTokens: 10 } };
                const result = request.messages.find(m => m.role === 'tool_result' && m.toolCallId === 'source');
                expect(result?.content).toContain('read_tool_result(');
                expect(result?.content).toContain('"callId":"source"');
                return { message: { role: 'assistant', content: 'done' }, stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 10 } };
            } }),
        } }] });
        const session = await client.create();
        await client.submit(session.id, 'Inspect source', { commandId: 'inspect' });
        const saved = await client.wait(session.id);
        expect(saved.status, saved.error).toBe('idle');
        expect(turns).toBe(2);
        const original = saved.messages.find(m => m.role === 'tool_result' && m.toolCallId === 'source')!;
        expect(original.content).toContain('evidence 199:');
        const { archiveToolRuntime } = await import('./archive.js');
        const archive = archiveToolRuntime(async () => (await client!.get(session.id)).messages);
        const page = await archive.call('read_tool_result', { callId: 'source', offset: 0 }, { sessionId: session.id });
        expect(page.ok).toBe(true);
        expect(page.content).toContain('evidence 0:');
    } finally { await client?.close(); await rm(workspace, { recursive: true, force: true }); }
});
it('composes read-only coding tools without hiding source recovery or relying on policy denial', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agentic-preset-read-only-'));
    try {
        await writeFile(join(workspace, 'source.ts'), 'Original evidence.');
        const defaults = await defaultAgentExtensions({ workspace });
        const readOnly = await defaultAgentExtensions({ workspace, readOnly: true });
        expect(compositionFingerprint(defaults)).not.toBe(compositionFingerprint(readOnly));
        expect(compositionFingerprint(defaults)).toBe(compositionFingerprint(await defaultAgentExtensions({ workspace, readOnly: false })));
        const tools = await readOnly.find(e => e.id === 'tools.coding')!.roles!.tools!();
        const names = tools.tools().map(t => t.name);
        expect(names).toEqual(expect.arrayContaining(['fs_read', 'fs_list', 'search_grep', 'search_find', 'read_tool_result']));
        for (const [name, args] of [
            ['fs_write', { path: 'source.ts', content: 'Changed' }],
            ['fs_patch', { path: 'source.ts', old_text: 'Original', new_text: 'Changed' }],
            ['shell_run', { command: 'echo changed' }],
        ] as const) {
            expect(names).not.toContain(name);
            expect(tools.validate(name, args).ok).toBe(false);
            expect((await tools.call(name, args)).ok).toBe(false);
        }
        expect((await tools.call('fs_read', { path: 'source.ts' })).ok).toBe(true);
        expect(await readFile(join(workspace, 'source.ts'), 'utf8')).toBe('Original evidence.');
    } finally { await rm(workspace, { recursive: true, force: true }); }
});
