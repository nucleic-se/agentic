import { constants, lstatSync } from 'node:fs';
import { mkdir, open, rename, realpath, link, unlink, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve, basename } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
export async function privateDirectory(directory: string) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Shell state directory must be private and owned');
    return realpath(directory);
}
export async function readReceiptText(file: string): Promise<string> {
    const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        let stat = await fd.stat();
        // Atomic replacement can unlink an already-open valid snapshot (nlink=0).
        // That is not an alias/hard-link violation; keep reading the pinned inode.
        if (stat.nlink === 2) {
            // Recover only our exclusive-publication alias, including a crash
            // between link and unlink. Arbitrary hard links remain forbidden.
            const parent = resolve(file, '..'), prefix = file.slice(parent.length + 1) + '.';
            const aliases = (await readdir(parent)).filter(name => name.startsWith(prefix) && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(name.slice(prefix.length)));
            for (const name of aliases) {
                const alias = join(parent, name);
                try {
                    const info = lstatSync(alias);
                    if (info.isFile() && info.dev === stat.dev && info.ino === stat.ino && !(info.mode & 0o077) && (!process.getuid || info.uid === process.getuid())) await unlink(alias);
                } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            }
            if ((await fd.stat()).nlink > 1) throw new Error('Invalid shell receipt hard link');
        }
        stat = await fd.stat();
        if (!stat.isFile() || stat.nlink > 1 || stat.size > 1024 * 1024 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Invalid shell receipt');
        return await fd.readFile('utf8');
    } finally { await fd.close(); }
}
export async function readReceipt<T>(file: string): Promise<T> { return JSON.parse(await readReceiptText(file)); }
export async function writeReceipt(file: string, value: unknown, exclusive = false) {
    const temp = file + '.' + randomUUID();
    const fd = await open(temp, 'wx', 0o600);
    try { await fd.writeFile(JSON.stringify(value)); await fd.sync(); } finally { await fd.close(); }
    if (exclusive) { await link(temp, file); await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); } else await rename(temp, file);
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
    status: 'running' | 'completed' | 'failed' | 'cancelled' | 'deadline_exceeded' | 'unknown' | 'stopped';
    commandPid?: number; commandBirth?: string; dispatched?: boolean;
    supervisorPid?: number; supervisorBirth?: string; startedAt: number; finishedAt?: number;
    exitCode?: number | null; signal?: string | null; reason?: string;
    result?: { content: string; [key: string]: unknown };
    resolution?: ShellProcessResolution;
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

export interface ShellProcessResolutionInput {
    owner: string; processId: string; expectedRequestHash: string; expectedReceiptHash: string; evidence: string;
}
export interface ShellProcessResolution extends ShellProcessResolutionInput {
    version: 1; effects: 'unresolved'; resolvedAt: number;
}
const rawHash = (text: string) => createHash('sha256').update(text).digest('hex');
async function processSnapshot(directory: string, id: string, owner: string) {
    if (!/^[a-f0-9]{64}$/.test(id) || typeof owner !== 'string' || !owner || owner.length > 2000) throw new Error('Invalid process identity');
    const folder = join(directory, id);
    // Inspection must not create state for an unknown execution.
    const info = lstatSync(folder);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error('Unsafe shell process directory');
    const requestText = await readReceiptText(join(folder, 'request.json'));
    const request = JSON.parse(requestText) as ShellRequest;
    if (request.version !== 1 || request.id !== id || request.owner !== owner) throw new Error('Shell process owner mismatch');
    const receiptText = await readReceiptText(receiptPath(folder));
    const receipt = validateShellReceipt(JSON.parse(receiptText));
    return { folder, request, receipt, requestHash: rawHash(requestText), receiptHash: rawHash(receiptText) };
}
/** Bounded host/operator metadata; command, environment and output remain private. */
export async function inspectShellProcess(directory: string, processId: string, owner: string) {
    const { receipt, requestHash, receiptHash } = await processSnapshot(directory, processId, owner);
    return { processId, owner, requestHash, receiptHash, status: receipt.status,
        supervisorPid: receipt.supervisorPid, supervisorBirth: receipt.supervisorBirth,
        commandPid: receipt.commandPid, commandBirth: receipt.commandBirth };
}
function validateResolution(value: unknown): ShellProcessResolution {
    const record = value as ShellProcessResolution;
    if (!record || record.version !== 1 || record.effects !== 'unresolved' ||
        typeof record.owner !== 'string' || !record.owner || record.owner.length > 2000 || !/^[a-f0-9]{64}$/.test(record.processId) ||
        !Number.isSafeInteger(record.resolvedAt) || record.resolvedAt < 0 ||
        typeof record.evidence !== 'string' || !record.evidence.trim() || record.evidence.length > 16000 ||
        !/^[a-f0-9]{64}$/.test(record.expectedRequestHash) || !/^[a-f0-9]{64}$/.test(record.expectedReceiptHash)) throw new Error('Invalid process resolution');
    return record;
}
function assertDead(pid: number | undefined, birth: string | undefined) {
    if (!Number.isSafeInteger(pid) || pid! < 1 || typeof birth !== 'string' || !birth) throw new Error('Missing execution identity; termination is not established');
    const current = processIdentity(pid!);
    if (current && current !== birth) return;
    if (current) throw new Error('Execution identity is still live');
    try { process.kill(pid!, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error; }
    throw new Error('Execution quiescence is indeterminate');
}
/** Caller must fence host admission. This records termination, never effect success. */
export async function resolveShellProcess(directory: string, value: ShellProcessResolutionInput): Promise<ShellProcessResolution> {
    const input = structuredClone(value);
    if (Object.keys(input).sort().join(',') !== 'evidence,expectedReceiptHash,expectedRequestHash,owner,processId') throw new Error('Unexpected resolution fields');
    const resolution = validateResolution({ ...input, version: 1, effects: 'unresolved', resolvedAt: Date.now() });
    const snapshot = await processSnapshot(directory, input.processId, input.owner);
    if (snapshot.requestHash !== input.expectedRequestHash || snapshot.receiptHash !== input.expectedReceiptHash) throw new Error('Process resolution snapshot changed');
    const file = join(snapshot.folder, 'resolution.json');
    const retry = async () => {
        const prior = validateResolution(await readReceipt(file));
        for (const key of Object.keys(input) as (keyof ShellProcessResolutionInput)[]) if (prior[key] !== input[key]) throw new Error('Conflicting process resolution');
        return prior;
    };
    try { return await retry(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!['running', 'unknown'].includes(snapshot.receipt.status)) throw new Error('Execution already has a terminal receipt');
    assertDead(snapshot.receipt.supervisorPid, snapshot.receipt.supervisorBirth);
    assertDead(snapshot.receipt.commandPid, snapshot.receipt.commandBirth);
    if (process.platform === 'win32') throw new Error('Process-group termination requires a supported host');
    // The original shell may be gone while its descendants retain the process group.
    try { process.kill(-snapshot.receipt.commandPid!, 0); throw new Error('Command process group is still live'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    const latest = await processSnapshot(directory, input.processId, input.owner);
    if (latest.requestHash !== input.expectedRequestHash || latest.receiptHash !== input.expectedReceiptHash) throw new Error('Process resolution snapshot changed');
    try { await writeReceipt(file, resolution, true); return resolution; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return retry(); throw error; }
}
/** Polling and maintenance use the same immutable evidence overlay. */
export async function readEffectiveShellReceipt(folder: string): Promise<ShellReceipt> {
    const text = await readReceiptText(receiptPath(folder));
    const receipt = validateShellReceipt(JSON.parse(text));
    let resolution: ShellProcessResolution;
    try { resolution = validateResolution(await readReceipt(join(folder, 'resolution.json'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return receipt; throw error; }
    const requestText = await readReceiptText(join(folder, 'request.json'));
    const request = JSON.parse(requestText) as ShellRequest;
    if (rawHash(text) !== resolution.expectedReceiptHash || rawHash(requestText) !== resolution.expectedRequestHash ||
        request.version !== 1 || request.id !== resolution.processId || basename(folder) !== resolution.processId || request.owner !== resolution.owner || !['running','unknown'].includes(receipt.status)) throw new Error('Process resolution no longer matches its source');
    return { status: 'stopped', startedAt: receipt.startedAt, resolution,
        reason: 'Operator established execution termination. Exit code and external effects remain unresolved; no command was replayed.' };
}
