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

it('recovers oversized human history through bounded checkpoints, including a rejected draft and serialized restart', async () => {
    const { agentContext } = await import('./agent-context.js');
    const { createHarnessExecution } = await import('./execution.js');
    const history: Message[] = Array.from({ length: 30 }, (_, i) => [
        { role: 'user' as const, content: `Meeting ${i}: ${'original evidence '.repeat(150)}` },
        { role: 'assistant' as const, content: `Read meeting ${i}` },
    ]).flat();
    history.push({ role: 'user', content: 'Current objective: finish the task' });
    const original = structuredClone(history);
    const context = agentContext('Host rules', 4000, { protectUserMessages: 'latest', checkpointMaxTokens: 256 });
    const provider = { turn: async () => { throw new Error('Must only prepare'); }, structured: async () => { throw new Error('unused'); } };
    const execution = createHarnessExecution({ context, provider });
    await expect(agentContext('Host rules', 4000).assemble(history, new AbortController().signal)).rejects.toThrow('protected');
    let state: unknown, calls = 0, repaired = false;
    const sourceIndexes = new Set<number>();
    for (;;) {
        const step = await context.lifecycle!.prepare({ request: { messages: history, maxTokens: 256 }, state }, execution);
        expect(step.prepared.report!.usage.totalTokens).toBeLessThanOrEqual(4000);
        if (step.kind === 'task') {
            expect(step.prepared.request.messages.some(m => m.content === history.at(-1)!.content)).toBe(true);
            expect(step.prepared.request.messages.some(m => m.content.includes('Preserved objective'))).toBe(true);
            expect(sourceIndexes.size).toBeGreaterThan(20);
            break;
        }
        const evidence = JSON.parse(step.prepared.request.messages[0].content);
        expect(evidence.requirements).toEqual([{ index: history.length - 1, content: history.at(-1)!.content }]);
        for (const source of evidence.sources ?? []) sourceIndexes.add(source.index);
        if (step.metadata.rejection) {
            repaired = true;
            expect(evidence.sources[0].content).toBe(history[0].content);
        }
        const transition = step.reduce({ message: { role: 'assistant', content: calls === 0 ? '' : 'Preserved objective; earlier meeting evidence processed.' },
            stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } });
        state = JSON.parse(JSON.stringify(transition.state));
        if (++calls > 40) throw new Error('Checkpointing failed to make progress');
    }
    expect(calls).toBeGreaterThan(2);
    expect(repaired).toBe(true);
    expect(history).toEqual(original);
});
