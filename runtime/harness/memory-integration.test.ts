import { expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ILLMProvider, ToolCall } from '../../contracts/llm.js';
import { defaultAgentExtensions } from './preset.js';
import { createHarness } from './host.js';

it('captures a real receipt and recalls it in a new session after both stores reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentic-recall-'));
    const reply = (calls: ToolCall[] = []) => ({ message: { role: 'assistant' as const, content: calls.length ? '' : 'done', toolCalls: calls },
        stopReason: calls.length ? 'tool_use' as const : 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } });
    const provider: ILLMProvider = { structured: async () => { throw new Error('unused'); }, turn: async request => {
        const results = request.messages.filter(message => message.role === 'tool_result');
        if (request.messages[0].content === 'learn') return results.length ? reply() : reply([
            { id: 'source', name: 'fs_read', args: { path: 'build.txt', mode: 'bytes', limit: 16000 } },
            { id: 'save', name: 'memory_save', args: { key: 'build', note: 'Use npm run verify', callId: 'source', limit: 100 } },
        ]);
        if (!results.length) return reply([{ id: 'search', name: 'memory_search', args: { text: 'build' } }]);
        if (results.length === 1) {
            expect(results[0].content).toMatch(/^\{"toolCallId":/);
            const [hit] = JSON.parse(results[0].content.slice(results[0].content.indexOf('\n') + 1));
            return reply([{ id: 'read', name: 'memory_read', args: { id: hit.id, version: hit.version } }]);
        }
        const value = JSON.parse(results.at(-1)!.content.slice(results.at(-1)!.content.indexOf('\n') + 1));
        if (value.eof === true) return reply();
        const [hit] = JSON.parse(results[0].content.slice(results[0].content.indexOf('\n') + 1));
        return reply([{ id: `page-${results.length}`, name: 'memory_read', args: { id: hit.id, version: hit.version, sourceOffset: value.nextOffset ?? 0 } }]);
    } };
    const open = async () => {
        const extensions = await defaultAgentExtensions({ workspace: root, database: join(root, 'sessions.sqlite'), memoryDatabase: join(root, 'notes.sqlite') });
        return createHarness().compose({ extensions: extensions.map(extension => extension.roles?.provider ? { ...extension, roles: { provider: () => provider } }
            : extension.roles?.policy ? { ...extension, roles: { policy: () => ({ evaluate: async () => ({ kind: 'allow' as const }) }) } } : extension) });
    };
    let client: Awaited<ReturnType<typeof open>> | undefined;
    try {
        await writeFile(join(root, 'build.txt'), 'Use npm run verify\n' + 'x'.repeat(8500) + '\noriginal tail');
        client = await open();
        const first = await client.create();
        await client.submit(first.id, 'learn', { commandId: 'learn' });
        const learned = await client.wait(first.id);
        expect(learned.operations.filter(operation => operation.kind === 'tool').map(operation => operation.status)).toEqual(['completed', 'completed']);
        await client.close(); client = undefined;
        await rm(join(root, 'build.txt'));
        client = await open();
        const second = await client.create();
        await client.submit(second.id, 'recall', { commandId: 'recall' });
        const recalled = await client.wait(second.id);
        const read = recalled.messages.find(message => message.role === 'tool_result' && message.toolName === 'memory_read');
        expect(read).toBeDefined();
        const note = JSON.parse(read!.content);
        expect(note.value.evidence.content).toContain('Use npm run verify');
        expect(note.source).toContain(`session/${first.id}/operation/`);
        expect(note.value.evidence.isError).toBe(false);
        const pages = recalled.messages.filter(message => message.role === 'tool_result' && message.toolName === 'memory_read')
            .slice(1).map(message => JSON.parse(message.content));
        const original = (learned.operations.find(operation => operation.callId === 'source')!.output as { result: { content: string } }).result.content;
        expect(pages.map(page => page.content).join('')).toBe(original);
        expect(pages.at(-1).eof).toBe(true);
    } finally { await client?.close(); await rm(root, { recursive: true, force: true }); }
});
