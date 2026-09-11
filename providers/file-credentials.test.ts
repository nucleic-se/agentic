import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FileCredentialStore } from './file-credentials.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'agentic-credentials-')); roots.push(root);
    const path = join(root, 'auth.json');
    return { root, path, store: new FileCredentialStore(path) };
}
const token = { type: 'oauth' as const, access: 'test-access', refresh: 'test-refresh', expires: 1000 };

it('preserves other provider entries, writes private files and lists metadata only', async () => {
    const { root, path, store } = await fixture();
    const other = { openai: { type: 'api_key', key: 'other-test-key' }, future: { custom: ['preserve', 'everything'] } };
    await writeFile(path, JSON.stringify(other));
    expect(await store.read('anthropic')).toBeUndefined();
    await store.modify('anthropic', async () => token);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ ...other, anthropic: token });
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await store.list()).toEqual([{ providerId: 'openai', type: 'api_key' }, { providerId: 'anthropic', type: 'oauth' }]);
    expect(await store.modify('anthropic', async () => undefined)).toEqual(token);
    expect(await store.modify('anthropic', async current => {
        if (current?.type === 'oauth') current.access = 'uncommitted-change';
        return undefined;
    })).toEqual(token);
    expect(await store.read('anthropic')).toEqual(token);
    await store.delete('anthropic');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(other);
    expect(await readdir(root)).toEqual(['auth.json']);
});

it('serializes read-modify-write across independent processes without lost updates', async () => {
    const { path, store } = await fixture();
    await store.modify('anthropic', async () => ({ ...token, counter: 0 }));
    const script = `import { FileCredentialStore } from ${JSON.stringify(new URL('../dist/providers/file-credentials.js', import.meta.url).href)};
        const store = new FileCredentialStore(process.argv[1]);
        for (let i = 0; i < 5; i++) await store.modify('anthropic', async current => {
            await new Promise(resolve => setTimeout(resolve, 5));
            return {...current, counter: current.counter + 1};
        });`;
    await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, path], { timeout: 10000 })));
    expect(await store.read('anthropic')).toEqual({ ...token, counter: 20 });
});

it('never steals locks and cancels waiting mutations before their callback starts', async () => {
    const { path } = await fixture();
    await mkdir(`${path}.lock`);
    const store = new FileCredentialStore(path, { lockTimeoutMs: 25 });
    let called = false;
    const mutation = async () => { called = true; return token; };
    await expect(store.modify('anthropic', mutation)).rejects.toThrow('lock timed out');
    await expect(new FileCredentialStore(path).modify('anthropic', mutation, { signal: AbortSignal.timeout(10) })).rejects.toThrow();
    expect(called).toBe(false);
    expect((await stat(`${path}.lock`)).isDirectory()).toBe(true);
    expect(await store.read('anthropic')).toBeUndefined();
});

it('persists an admitted rotated token despite cancellation and releases locks after callback failure', async () => {
    const { root, store } = await fixture();
    const controller = new AbortController();
    await store.modify('anthropic', async () => {
        controller.abort();
        return token;
    }, { signal: controller.signal });
    expect(await store.read('anthropic')).toEqual(token);
    await expect(store.modify('anthropic', async () => { throw new Error('Refresh failed'); })).rejects.toThrow('Refresh failed');
    expect(await store.read('anthropic')).toEqual(token);
    expect(await readdir(root)).toEqual(['auth.json']);
    await store.modify('anthropic', async () => ({ ...token, access: 'next-test-access' }));
    expect((await store.read('anthropic'))?.type).toBe('oauth');
});

it('rejects malformed storage without disclosing or overwriting its contents', async () => {
    const { root, path, store } = await fixture();
    const malformed = '{"anthropic":"PRIVATE-TEST-CONTENT';
    await writeFile(path, malformed);
    await expect(store.modify('anthropic', async () => token)).rejects.toThrow('Credential file must contain valid UTF-8 JSON');
    expect(await readFile(path, 'utf8')).toBe(malformed);
    expect(await readdir(root)).toEqual(['auth.json']);
});

it.skipIf(process.platform === 'win32')('rejects credential-file symlinks without modifying their target', async () => {
    const { root, path, store } = await fixture();
    const target = join(root, 'target');
    await writeFile(target, '{}');
    await symlink(target, path);
    await expect(store.modify('anthropic', async () => token)).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('{}');
});
