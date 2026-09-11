import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { codingToolRuntime } from './defaults.js';

let root: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'change-review-'));
    git('init', '-q');
    git('config', 'user.name', 'Review Test');
    git('config', 'user.email', 'test@example.invalid');
    await writeFile(join(root, 'source.js'), 'const label = "hello world";\n');
    git('add', '.');
    git('commit', '-qm', 'Baseline');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('reviews staged and unstaged changes, labels whitespace limitations and recovers the exact patch after reopening', async () => {
    await writeFile(join(root, 'source.js'), 'const label = "helloworld";\n');
    await writeFile(join(root, 'staged.css'), 'body { color: red; }\n');
    git('add', 'staged.css');
    await writeFile(join(root, 'new page.html'), '<h1>Untracked</h1>');
    const options = { outputDirectory: join(root, '.outputs') };
    const runtime = codingToolRuntime(root, options);
    const review = await runtime.call('review_changes', {});
    expect(review.ok, review.content).toBe(true);
    expect(review.content).toContain('source.js');
    expect(review.content).toContain('staged.css');
    expect(review.content).toContain('"new page.html"');
    expect(review.content).toContain('not semantic equivalence');
    const { outputId, patchOffset } = review.data as { outputId: string; patchOffset: number };
    const reopened = codingToolRuntime(root, options);
    const page = JSON.parse((await reopened.call('read_output', { id: outputId, offset: patchOffset })).content);
    expect(page).toMatchObject({ eof: true });
    expect(page.content).toBe(git('diff', '--relative', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--ignore-submodules=none', '--binary', '--full-index', 'HEAD', '--', '.'));
    expect(page.content).not.toContain('Untracked');
    expect(runtime.effectFor?.('review_changes')).toBe('write');
});

it('reports a whitespace-ignored empty diff without claiming the string edit is behavior-preserving', async () => {
    await writeFile(join(root, 'source.js'), 'const label = "helloworld";\n');
    const review = await codingToolRuntime(root).call('review_changes', {});
    expect(review.content).toContain('No tracked differences under -w. Whitespace can still affect behavior.');
});

it('bounds large review summaries and pages a long Unicode patch without losing text', async () => {
    await writeFile(join(root, 'source.js'), Array.from({ length: 1000 }, (_, i) => `// 🌱 ${i}`).join('\n'));
    const runtime = codingToolRuntime(root);
    const review = await runtime.call('review_changes', {});
    expect(review.ok).toBe(true);
    expect(review.content.length).toBeLessThan(4000);
    const { outputId, patchOffset } = review.data as { outputId: string; patchOffset: number };
    let offset = patchOffset, patch = '';
    while (true) {
        const page = JSON.parse((await runtime.call('read_output', { id: outputId, offset })).content);
        patch += page.content;
        if (page.eof) break;
        offset = page.nextOffset;
    }
    expect(patch).toContain('// 🌱 999');
    expect(patch).toBe(git('diff', '--relative', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--ignore-submodules=none', '--binary', '--full-index', 'HEAD', '--', '.'));
});

it('scopes review to the workspace, rejects option injection, and respects pre-cancellation', async () => {
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested/local'), 'local');
    await writeFile(join(root, 'outside'), 'outside');
    git('add', '.');
    git('commit', '-qm', 'Files');
    await writeFile(join(root, 'nested/local'), 'changed local');
    await writeFile(join(root, 'outside'), 'changed outside');
    const runtime = codingToolRuntime(join(root, 'nested'));
    const review = await runtime.call('review_changes', {});
    expect(review.content).toContain('local');
    expect(review.content).not.toContain('outside');
    expect((await runtime.call('review_changes', { base: '--output=unwanted' })).ok).toBe(false);
    expect(await runtime.call('review_changes', {}, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, errorKind: 'cancelled' });
});


it.skipIf(process.platform === 'win32')('kills Git helpers before returning cancellation', async () => {
    const hook = join(root, 'monitor.sh');
    const started = join(root, 'started');
    await writeFile(hook, '#!/bin/sh\necho $$ > "' + started + '"\nsleep 30\n');
    await chmod(hook, 0o755);
    git('config', 'core.fsmonitor', hook);
    const controller = new AbortController();
    const pending = codingToolRuntime(root).call('review_changes', {}, { signal: controller.signal });
    let pid = 0;
    try {
        await vi.waitFor(async () => { pid = Number((await readFile(started, 'utf8')).trim()); expect(pid).toBeGreaterThan(0); });
    } finally { controller.abort(); }
    expect(await pending).toMatchObject({ ok: false, errorKind: 'cancelled' });
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
});


it('stops oversized Git output without saving a partial review', async () => {
    await writeFile(join(root, 'source.js'), 'x'.repeat(9 * 1024 * 1024));
    const review = await codingToolRuntime(root).call('review_changes', {});
    expect(review).toMatchObject({ ok: false, errorKind: 'unknown' });
    expect(review.content).toContain('8 MiB');
    expect(review.data).toBeUndefined();
    expect(review.content).not.toContain('Saved review:');
});
