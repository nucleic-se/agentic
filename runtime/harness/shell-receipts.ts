import { constants, lstatSync } from 'node:fs';
import { mkdir, open, rename, realpath, link, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
export async function privateDirectory(directory: string) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Shell state directory must be private and owned');
    return realpath(directory);
}
export async function readReceipt<T>(file: string): Promise<T> {
    const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = await fd.stat();
        // Atomic replacement can unlink an already-open valid snapshot (nlink=0).
        // That is not an alias/hard-link violation; keep reading the pinned inode.
        if (stat.nlink === 2) throw Object.assign(new Error('Receipt publication in progress'), { code: 'EAGAIN' });
        if (!stat.isFile() || stat.nlink > 1 || stat.size > 1024 * 1024 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Invalid shell receipt');
        return JSON.parse(await fd.readFile('utf8'));
    } finally { await fd.close(); }
}
export async function writeReceipt(file: string, value: unknown, exclusive = false) {
    const temp = file + '.' + randomUUID();
    const fd = await open(temp, 'wx', 0o600);
    try { await fd.writeFile(JSON.stringify(value)); await fd.sync(); } finally { await fd.close(); }
    if (exclusive) { await link(temp, file); await unlink(temp); } else await rename(temp, file);
    // Directory entry durability is needed before dispatching the command.
    if (process.platform !== 'win32') { const parent = await open(resolve(file, '..'), 'r'); try { await parent.sync(); } finally { await parent.close(); } }
}
/** Birth identity prevents a reused PID from being mistaken for the supervisor. */
export function processIdentity(pid: number): string | undefined {
    try { return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined; }
    catch { return undefined; }
}
export interface ShellRequest {
    version: 1; id: string; owner: string; createdAt: number; sessionId?: string; callId?: string; command: string; cwd: string;
    env?: Record<string, string>; executionTimeoutMs?: number; requestHash: string;
}
export interface ShellReceipt {
    status: 'running' | 'completed' | 'failed' | 'cancelled' | 'deadline_exceeded' | 'unknown';
    commandPid?: number; commandBirth?: string; dispatched?: boolean;
    supervisorPid?: number; supervisorBirth?: string; startedAt: number; finishedAt?: number;
    exitCode?: number | null; signal?: string | null; reason?: string;
    result?: { content: string; [key: string]: unknown };
}
export const receiptPath = (directory: string) => join(directory, 'receipt.json');

/** Validate lifecycle evidence before reporting completion or accepting drain. */
export function validateShellReceipt(value: unknown): ShellReceipt {
    const receipt = value as ShellReceipt;
    if (!receipt || !['running','completed','failed','cancelled','deadline_exceeded','unknown'].includes(receipt.status) ||
        !Number.isSafeInteger(receipt.startedAt) || receipt.startedAt < 0 ||
        (receipt.supervisorPid !== undefined && (!Number.isSafeInteger(receipt.supervisorPid) || receipt.supervisorPid < 1))) throw new Error('Invalid shell process receipt');
    if (!['running','unknown'].includes(receipt.status)) {
        if (!Number.isSafeInteger(receipt.finishedAt) || receipt.finishedAt! < receipt.startedAt ||
            !(receipt.exitCode === null || Number.isSafeInteger(receipt.exitCode)) ||
            !(receipt.signal === null || typeof receipt.signal === 'string')) throw new Error('Missing terminal shell evidence');
        if (receipt.status === 'completed' && (receipt.exitCode !== 0 || receipt.signal !== null)) throw new Error('Invalid successful shell completion');
        if (receipt.status === 'failed' && receipt.exitCode === 0 && receipt.signal === null && !receipt.reason) throw new Error('Invalid failed shell completion');
    }
    return receipt;
}
