import { expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
        const extensions = (await defaultAgentExtensions({ workspace, tokenBudget: 3500, outputTokens: 100, textPageBytes: 16000 }))
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
