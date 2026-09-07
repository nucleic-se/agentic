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
