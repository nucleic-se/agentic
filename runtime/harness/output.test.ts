import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileToolOutputStore, ToolOutputCapture, MAX_CAPTURE_BYTES } from './output.js';
import { codingToolRuntime } from './defaults.js';
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'agentic-output-test-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('recovers shell output beyond the old cap exactly after reopening, without repeating execution', async () => {
    const expected = 'first error\n' + 'a'.repeat(70000) + '😀\nlast diagnostic\n';
    await writeFile(join(root, 'run.cjs'), `require('node:fs').appendFileSync('runs','1'); process.stdout.write(${JSON.stringify(expected)}); process.exitCode=1;`);
    const options = { outputDirectory: join(root, 'saved') };
    const runtime = codingToolRuntime(root, options);
    const result = await runtime.call('shell_run', { command: 'node run.cjs' });
    expect(result).toMatchObject({ ok: false, errorKind: 'runtime', data: { incomplete: false, exitCode: 1 } });
    expect(result.content).toContain('first error');
    expect(result.content).toContain('last diagnostic');
    expect(result.content.length).toBeLessThan(4100);
    const reopened = codingToolRuntime(root, options), id = (result.data as { outputId: string }).outputId;
    let offset = 0, restored = '';
    while (true) {
        const read = await reopened.call('read_output', { id, offset });
        expect(read.ok).toBe(true);
        const page = JSON.parse(read.content);
        restored += page.content;
        if (page.eof) break;
        expect(page.nextOffset).toBeGreaterThan(offset);
        offset = page.nextOffset;
    }
    expect(restored).toBe(expected);
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(join(root, 'runs'), 'utf8')).toBe('1');
    expect((await reopened.call('read_output', { id, offset: expected.length + 1 })).ok).toBe(false);
});

it('marks capture overflow explicitly and retains a retrievable bounded prefix', async () => {
    const capture = new ToolOutputCapture(), store = new FileToolOutputStore(root);
    capture.append(Buffer.alloc(MAX_CAPTURE_BYTES + 10, 97));
    const result = await capture.finish(store);
    expect(result).toMatchObject({ incomplete: true, capturedBytes: MAX_CAPTURE_BYTES, totalBytes: MAX_CAPTURE_BYTES + 10 });
    expect(result.content).toContain('Capture incomplete');
    expect(await store.read(result.outputId!, MAX_CAPTURE_BYTES - 3)).toMatchObject({ content: 'aaa', eof: true });
});

it('makes storage failure visible without inventing a recovery reference', async () => {
    const file = join(root, 'file'); await writeFile(file, 'occupied');
    const capture = new ToolOutputCapture(); capture.append(Buffer.from('x'.repeat(5000)));
    const result = await capture.finish(new FileToolOutputStore(file));
    expect(result.outputId).toBeUndefined();
    expect(result.storageError).toBeTruthy();
    expect(result.content).toContain('full output unavailable');
});

it('rejects unowned paths, missing results and symlink output files', async () => {
    const store = new FileToolOutputStore(root), id = '00000000-0000-4000-8000-000000000000';
    await expect(store.read('../escape', 0)).rejects.toThrow('Invalid output ID');
    await expect(store.read(id, 0)).rejects.toThrow();
    await symlink(join(root, 'target'), join(root, id));
    await writeFile(join(root, 'target'), 'outside evidence');
    await expect(store.read(id, 0)).rejects.toThrow();
});
