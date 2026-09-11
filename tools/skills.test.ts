import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSkills, skillCatalogText, skillToolRuntime } from './skills.js';
import { createHarness } from '../runtime/harness/core.js';
import { MemorySessionStore } from '../runtime/harness/stores.js';
import { conversationalLoop } from '../runtime/harness/loops.js';
import { codingAgentContext } from '../runtime/harness/agent-context.js';
import type { ILLMProvider, TurnRequest } from '../contracts/llm.js';
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'agentic-skills-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const skill = (name: string, body = 'PRIVATE PROCEDURE: check the report.') => `---\nname: ${name}\ndescription: Check a report\n---\n${body}`;

it('loads explicit snapshots deterministically and preserves paged Unicode instructions', async () => {
    for (const name of ['z-last', 'a-first']) { await mkdir(join(root, name)); await writeFile(join(root, name, 'SKILL.md'), skill(name, '🌱'.repeat(5000))); }
    const catalog = await loadSkills({ directories: [root] });
    expect(catalog.entries.map(entry => entry.name)).toEqual(['a-first', 'z-last']);
    expect(skillCatalogText(catalog)).not.toContain('🌱');
    expect(catalog.identity).toBe((await loadSkills({ directories: [join(root, 'z-last'), join(root, 'a-first')] })).identity);
    const runtime = skillToolRuntime(catalog);
    let offset = 0, text = '';
    do {
        const result = await runtime.call('read_skill', { name: 'a-first', offset });
        const page = JSON.parse(result.content);
        expect(page.content.length).toBeLessThanOrEqual(4000);
        text += page.content; offset = page.nextOffset;
        if (page.eof) break;
    } while (true);
    expect(text).toBe(catalog.entries[0].content);
    await writeFile(join(root, 'a-first', 'SKILL.md'), skill('a-first', 'changed'));
    expect((await loadSkills({ directories: [root] })).identity).not.toBe(catalog.identity);
    expect(JSON.parse((await runtime.call('read_skill', { name: 'a-first' })).content).content).not.toContain('changed');
    expect(Object.isFrozen(catalog.entries[0])).toBe(true);
});

it('rejects duplicates, oversized files, bad UTF-8 and symlink skill files', async () => {
    for (const name of ['one', 'two']) { await mkdir(join(root, name)); await writeFile(join(root, name, 'SKILL.md'), skill('same')); }
    await expect(loadSkills({ directories: [root] })).rejects.toThrow('Duplicate skill');
    await rm(join(root, 'two'), { recursive: true });
    const file = join(root, 'one', 'SKILL.md');
    await writeFile(file, 'x'.repeat(65537));
    await expect(loadSkills({ directories: [root] })).rejects.toThrow('64 KiB');
    await writeFile(file, Buffer.from([255]));
    await expect(loadSkills({ directories: [root] })).rejects.toThrow();
    await rm(file); await writeFile(join(root, 'outside'), skill('outside')); await symlink(join(root, 'outside'), file);
    await expect(loadSkills({ directories: [root] })).rejects.toThrow('regular file');
});

it('reads common quoted and folded metadata without executing other frontmatter fields', async () => {
    await writeFile(join(root, 'SKILL.md'), '---\nname: "review"\ndescription: >- # folded metadata\n  Check the\n  report carefully.\nallowed-tools: shell_run\n---\nRun nothing automatically.');
    const catalog = await loadSkills({ directories: [root] });
    expect(catalog.entries[0].description).toBe('Check the report carefully.');
    const tools = skillToolRuntime(catalog);
    expect(tools.tools().map(tool => tool.name)).toEqual(['read_skill']);
    expect(tools.effectFor?.('read_skill')).toBe('read');
    expect((await tools.call('read_skill', { name: '../outside' })).ok).toBe(false);
    expect((await tools.call('read_skill', { name: 'review', extra: true })).ok).toBe(false);
    expect(await tools.call('read_skill', { name: 'review' }, { signal: AbortSignal.abort() })).toMatchObject({ errorKind: 'cancelled' });
});

it('budgets the catalog and loads full instructions through host authorization and receipts', async () => {
    await writeFile(join(root, 'SKILL.md'), skill('review'));
    const catalog = await loadSkills({ directories: [root] });
    const context = codingAgentContext({ workspace: root, tokenBudget: 8000, checkpointing: false, additionalInstructions: skillCatalogText(catalog) });
    const prepared = await context.assemble([{ role: 'user', content: 'Review' }], new AbortController().signal);
    expect(prepared.system).toContain('review');
    expect(prepared.system).not.toContain('PRIVATE PROCEDURE');
    const without = codingAgentContext({ workspace: root, tokenBudget: 8000, checkpointing: false });
    const baseline = await without.assemble([{ role: 'user', content: 'Review' }], new AbortController().signal);
    expect(prepared.report!.usage.systemTokens).toBeGreaterThan(baseline.report!.usage.systemTokens);
    const requests: TurnRequest[] = [];
    const provider: ILLMProvider = { embed: async () => [], structured: async () => { throw Error('unused'); }, async turn(request) {
        requests.push(request);
        return requests.length === 1 ? { message: { role: 'assistant', content: '', toolCalls: [{ id: 'read', name: 'read_skill', args: { name: 'review' } }] }, stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } }
            : { message: { role: 'assistant', content: 'Reviewed' }, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    } };
    for (const allow of [true, false]) {
        requests.length = 0;
        const client = await createHarness().compose({ extensions: [{ id: 'test', version: '1', apiVersion: 1, configuration: catalog.identity, roles: {
            store: () => new MemorySessionStore(), context: () => context, provider: () => provider,
            loop: () => conversationalLoop(), tools: () => skillToolRuntime(catalog), policy: () => ({ evaluate: async () => allow ? { kind: 'allow' } : { kind: 'deny', reason: 'Not granted' } }),
        } }] });
        try {
            const session = await client.create(); await client.submit(session.id, 'Review', { commandId: 'go' });
            const record = await client.wait(session.id);
            expect(record.status).toBe('idle');
            const text = requests[1].messages.filter(message => message.role === 'tool_result').map(message => message.content).join('');
            expect(text.includes('PRIVATE PROCEDURE')).toBe(allow);
            expect(record.operations.filter(operation => operation.kind === 'tool')).toHaveLength(allow ? 1 : 0);
        } finally { await client.close(); }
    }
});
