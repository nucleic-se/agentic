import { expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codingAgentContext } from './agent-context.js';
import { defaultAgentExtensions } from './preset.js';
import type { Message } from '../../contracts/llm.js';

it('shares the default coding context with another driver and refreshes workspace instructions', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'shared-coding-context-'));
    try {
        await writeFile(join(workspace, 'AGENTS.md'), 'FIRST_WORKSPACE_RULE');
        const local = await (await defaultAgentExtensions({ workspace, tokenBudget: 16000 })).find(e => e.roles?.context)!.roles!.context!();
        const other = codingAgentContext({ workspace, tokenBudget: 16000 });
        const messages: Message[] = [{ role: 'user', content: 'Inspect source' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'source', name: 'read', args: {} }] },
            { role: 'tool_result', toolCallId: 'source', content: 'Original evidence' }];
        const signal = new AbortController().signal;
        for (const rule of ['FIRST_WORKSPACE_RULE', 'UPDATED_WORKSPACE_RULE']) {
            await writeFile(join(workspace, 'AGENTS.md'), rule);
            const actual = await other.assemble(messages, signal);
            expect(actual).toEqual(await local.assemble(messages, signal));
            expect(actual.system).toContain(rule);
            expect(actual.messages.at(-1)?.content).toContain('"toolCallId":"source"');
            expect(messages.at(-1)?.content).toBe('Original evidence');
        }
        const maintenance = await other.assemble(messages, signal, { system: 'Maintenance owns this request', reservedOutputTokens: 100 });
        expect(maintenance.system).toBe('Maintenance owns this request');
        expect(maintenance.report?.usage.reservedOutputTokens).toBe(100);
    } finally { await rm(workspace, { recursive: true, force: true }); }
});
