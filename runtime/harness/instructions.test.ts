import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjectInstructions } from './instructions.js';
import { defaultAgentExtensions } from './preset.js';
import { compositionFingerprint } from './composition.js';

const roots: string[] = [];
async function workspace() { const root = await mkdtemp(join(tmpdir(), 'agentic-instructions-')); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('includes discovered instructions in the default context budget and composition identity', async () => {
    const root = await workspace();
    await writeFile(join(root, 'AGENTS.md'), 'Run node --test before reporting completion.');
    const extensions = await defaultAgentExtensions({ workspace: root });
    const context = await extensions.find(extension => extension.roles?.context)!.roles!.context!();
    const request = await context.assemble([{ role: 'user', content: 'Fix the parser' }], new AbortController().signal);
    expect(request.system).toContain('Source: AGENTS.md');
    expect(request.system).toContain('Run node --test before reporting completion.');
    expect(request.report!.usage.totalTokens).toBeGreaterThan(0);
    await writeFile(join(root, 'AGENTS.md'), 'Run npm test before reporting completion.');
    expect(compositionFingerprint(await defaultAgentExtensions({ workspace: root }))).not.toBe(compositionFingerprint(extensions));
});

it('loads applicable scopes once and preserves exact text and source paths', async () => {
    const root = await workspace();
    await mkdir(join(root, 'src', 'nested'), { recursive: true });
    await mkdir(join(root, 'unrelated'));
    await writeFile(join(root, 'AGENTS.md'), 'Root instructions\n');
    await writeFile(join(root, 'src', 'AGENTS.md'), 'Scoped correction 🙂\n');
    await writeFile(join(root, 'unrelated', 'AGENTS.md'), 'Not applicable');
    expect(await readProjectInstructions(root, ['src/nested', 'src'])).toEqual([
        { path: 'AGENTS.md', directory: '.', content: 'Root instructions\n' },
        { path: 'src/AGENTS.md', directory: 'src', content: 'Scoped correction 🙂\n' },
    ]);
    await writeFile(join(root, 'AGENTS.md'), 'Updated');
    expect((await readProjectInstructions(root))[0].content).toBe('Updated');
});

it('rejects escaping scopes and sources, excessive instructions and cancellation', async () => {
    const root = await workspace(), outside = await workspace();
    await writeFile(join(outside, 'AGENTS.md'), 'External');
    await expect(readProjectInstructions(root, ['../'])).rejects.toThrow('escapes');
    await symlink(join(outside, 'AGENTS.md'), join(root, 'AGENTS.md'));
    await expect(readProjectInstructions(root)).rejects.toThrow('escapes');
    await rm(join(root, 'AGENTS.md'));
    await writeFile(join(root, 'AGENTS.md'), 'x'.repeat(65537));
    await expect(readProjectInstructions(root)).rejects.toThrow('64 KiB');
    await expect(readProjectInstructions(root, ['.'], AbortSignal.abort())).rejects.toThrow();
});
