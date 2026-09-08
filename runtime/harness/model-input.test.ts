import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Built coding tools own worker entrypoints. npm test builds before execution.
import { createHarness, defaultAgentExtensions, codingToolRuntime, readArchivedToolResult } from '../../dist/runtime/harness/index.js';
import type { ILLMProvider } from '../../contracts/llm.js';

it('keeps escaped byte-page JSON exact through the default host and reopening', async () => {
    const root = await mkdtemp(join(tmpdir(), 'input-fidelity-'));
    const source = '"'.repeat(16000);
    let turns = 0;
    const provider: ILLMProvider = { structured: async () => { throw new Error('unused'); }, turn: async request => {
        if (!turns++) return { message: { role: 'assistant', content: '', toolCalls: [{ id: 'source', name: 'fs_read', args: { path: 'source', mode: 'bytes', limit: 16000 } }] }, stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } };
        const result = request.messages.find(m => m.role === 'tool_result');
        expect(JSON.parse(result!.content.replace(/^\{"toolCallId"[^\n]*\n/, '')).content).toBe(source);
        return { message: { role: 'assistant', content: 'done' }, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    } };
    let client: Awaited<ReturnType<ReturnType<typeof createHarness>['compose']>> | undefined;
    try {
        await writeFile(join(root, 'source'), source);
        const extensions = (await defaultAgentExtensions({ workspace: root, database: join(root, 'sessions.sqlite'), readOnly: true }))
            .map(e => e.roles?.provider ? { ...e, roles: { provider: () => provider } } : e);
        client = await createHarness().compose({ extensions });
        const session = await client.create();
        await client.submit(session.id, 'Read exact source', { commandId: 'read' });
        const state = await client.wait(session.id);
        expect(state.status, state.error).toBe('idle');
        const saved = state.messages.find(m => m.role === 'tool_result')!;
        expect(JSON.parse(saved.content).content).toBe(source);
        await client.close(); client = undefined;
        // A fresh composition reactivates archive access against the persisted transcript.
        const reopened = (await defaultAgentExtensions({ workspace: root, database: join(root, 'sessions.sqlite'), readOnly: true }))
            .map(e => e.roles?.provider ? { ...e, roles: { provider: () => provider } } : e);
        client = await createHarness().compose({ extensions: reopened });
        const history = (await client.get(session.id)).messages;
        let offset = 0, exact = '';
        for (;;) {
            const page = readArchivedToolResult(history, { callId: 'source', offset });
            exact += page.content;
            if (page.eof) break;
            offset = page.nextOffset;
        }
        expect(exact).toBe(saved.content);
    } finally { await client?.close(); await rm(root, { recursive: true, force: true }); }
});

it('searches project and hidden configuration before ignored dependencies, with an explicit override', async () => {
    const root = await mkdtemp(join(tmpdir(), 'search-scope-'));
    try {
        for (const directory of ['node_modules/vendor', 'src', '.github', '.git']) await mkdir(join(root, directory), { recursive: true });
        await writeFile(join(root, '.gitignore'), 'node_modules/\nsrc/*.ts\n');
        await writeFile(join(root, 'src', '.gitignore'), '!kept.ts\n');
        await writeFile(join(root, 'node_modules/vendor/file.ts'), 'needle vendor\n'.repeat(10));
        await writeFile(join(root, 'src/kept.ts'), 'needle project');
        await writeFile(join(root, 'src/skipped.ts'), 'needle ignored');
        await writeFile(join(root, '.github/check.yml'), 'workflow needle');
        await writeFile(join(root, '.git/internal'), 'git needle');
        const tools = codingToolRuntime(root, { readOnly: true });
        const normal = await tools.call('search_grep', { pattern: 'needle' });
        expect(normal.ok, normal.content).toBe(true);
        expect(normal.content).toContain('.github/check.yml');
        expect(normal.content).toContain('src/kept.ts');
        expect(normal.content).not.toContain('vendor');
        expect(normal.content).not.toContain('skipped');
        const all = await tools.call('search_grep', { pattern: 'needle', include_ignored: true });
        expect(all.content).toContain('vendor');
        expect(all.content).toContain('skipped');
        expect(all.content).not.toContain('git needle');
        const found = await tools.call('search_find', { pattern: '**/*.ts' });
        expect(found.content).toContain('src/kept.ts');
        expect(found.content).not.toContain('vendor');
    } finally { await rm(root, { recursive: true, force: true }); }
});

it('validates UTF-8 byte ceilings and keeps application-specific paths usable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coding-contract-'));
    try {
        const tools = codingToolRuntime(root);
        expect(tools.validate('fs_write', { path: 'file', content: 'é'.repeat(131073) }).ok).toBe(false);
        expect(tools.validate('fs_write', { path: 'file', content: 'é'.repeat(131072) }).ok).toBe(true);
        const write = await tools.call('fs_write', { path: 'agents/demo/state.md', content: 'state' });
        expect(write.ok, write.content).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
});
