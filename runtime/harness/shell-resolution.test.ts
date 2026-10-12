import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as receipts from './shell-receipts.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'shell-resolution-')); roots.push(root);
    const id = 'a'.repeat(64), folder = join(root, id);
    await mkdir(folder, { mode: 0o700 });
    await receipts.writeReceipt(join(folder, 'request.json'), { version: 1, id, owner: 'scope-a',
        requestHash: 'b'.repeat(64), createdAt: 1, command: 'synthetic', cwd: root });
    await receipts.writeReceipt(join(folder, 'receipt.json'), { status: 'running', startedAt: 1,
        supervisorPid: 999999999, supervisorBirth: 'absent', commandPid: 999999998, commandBirth: 'absent', dispatched: true });
    return { root, id, folder };
}
const api = receipts as any;
it('retains original receipt and makes stopped execution inspectable without inventing success', async () => {
    const { root, id, folder } = await fixture();
    const before = await readFile(join(folder, 'receipt.json'), 'utf8');
    const snapshot = await api.inspectShellProcess(root, id, 'scope-a');
    const input = { owner: 'scope-a', processId: id, expectedRequestHash: snapshot.requestHash,
        expectedReceiptHash: snapshot.receiptHash, evidence: 'Both execution identities and command group are absent.' };
    await api.resolveShellProcess(root, input);
    expect(await readFile(join(folder, 'receipt.json'), 'utf8')).toBe(before);
    const effective = await api.readEffectiveShellReceipt(folder);
    expect(effective).toMatchObject({ status: 'stopped', resolution: { effects: 'unresolved' } });
    expect(effective.exitCode).toBeUndefined();
    expect(await api.resolveShellProcess(root, input)).toMatchObject({ effects: 'unresolved' });
    await expect(api.resolveShellProcess(root, { ...input, evidence: 'Different evidence' })).rejects.toThrow();
});
it('rejects changed receipts, wrong owners and live execution', async () => {
    const { root, id, folder } = await fixture();
    const snapshot = await api.inspectShellProcess(root, id, 'scope-a');
    const input = { owner: 'scope-a', processId: id, expectedRequestHash: snapshot.requestHash,
        expectedReceiptHash: snapshot.receiptHash, evidence: 'Inspected execution.' };
    await expect(api.resolveShellProcess(root, { ...input, owner: 'scope-b' })).rejects.toThrow();
    await writeFile(join(folder, 'receipt.json'), JSON.stringify({ status: 'running', startedAt: 2,
        supervisorPid: process.pid, supervisorBirth: receipts.processIdentity(process.pid),
        commandPid: process.pid, commandBirth: receipts.processIdentity(process.pid) }), { mode: 0o600 });
    await expect(api.resolveShellProcess(root, input)).rejects.toThrow();
    const live = await api.inspectShellProcess(root, id, 'scope-a');
    await expect(api.resolveShellProcess(root, { ...input, expectedReceiptHash: live.receiptHash })).rejects.toThrow(/live|quiescen/i);
});
it('refuses missing identities and serializes conflicting concurrent resolutions', async () => {
    const { root, id, folder } = await fixture();
    const snapshot = await api.inspectShellProcess(root, id, 'scope-a');
    const input = { owner: 'scope-a', processId: id, expectedRequestHash: snapshot.requestHash,
        expectedReceiptHash: snapshot.receiptHash, evidence: 'Inspected execution.' };
    const outcomes = await Promise.allSettled([api.resolveShellProcess(root, input),
        api.resolveShellProcess(root, { ...input, evidence: 'Conflicting inspection' })]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const other = await fixture();
    await receipts.writeReceipt(join(other.folder, 'receipt.json'), { status: 'running', startedAt: 1 });
    const absent = await api.inspectShellProcess(other.root, other.id, 'scope-a');
    await expect(api.resolveShellProcess(other.root, { ...input, expectedRequestHash: absent.requestHash, expectedReceiptHash: absent.receiptHash })).rejects.toThrow(/identit/i);
});
it('rejects stopped status in a raw receipt without source-bound evidence', async () => {
    const { folder } = await fixture();
    await receipts.writeReceipt(join(folder, 'receipt.json'), { status: 'stopped', startedAt: 1, resolution: { effects: 'unresolved' } });
    await expect(receipts.readEffectiveShellReceipt(folder)).rejects.toThrow(/Invalid/);
});
it('recovers an exclusive publication interrupted after linking its private temporary inode', async () => {
    const { root, id, folder } = await fixture();
    const snapshot = await receipts.inspectShellProcess(root, id, 'scope-a');
    const input = { owner: 'scope-a', processId: id, expectedRequestHash: snapshot.requestHash, expectedReceiptHash: snapshot.receiptHash, evidence: 'Identities absent.' };
    const resolution = await receipts.resolveShellProcess(root, input);
    const { link } = await import('node:fs/promises');
    const file = join(folder, 'resolution.json');
    await link(file, file + '.00000000-0000-4000-8000-000000000000');
    expect(await receipts.resolveShellProcess(root, input)).toEqual(resolution);
    expect((await receipts.readEffectiveShellReceipt(folder)).status).toBe('stopped');
});
