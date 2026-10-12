import { StringDecoder } from 'node:string_decoder';
import { readTextPage } from '../ToolOutput.js';
import { MAX_CAPTURE_BYTES } from './output.js';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { mkdir, open, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolCallOptions, ToolCallResult } from '../../contracts/tool-runtime.js';
import { privateDirectory, readReceipt, writeReceipt, receiptPath, processIdentity, readEffectiveShellReceipt, type ShellRequest, type ShellReceipt } from './shell-receipts.js';
function stable(value: unknown): string {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + stable(v)).join(',') + '}';
    return JSON.stringify(value) ?? 'null';
}
const digest = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
export class ShellProcesses {
    constructor(private directory: string, private outputDirectory: string, private ownerNamespace?: string) {}
    private owner(options?: ToolCallOptions) { return this.ownerNamespace ?? options?.sessionId ?? 'standalone'; }
    private async request(id: string, options?: ToolCallOptions) {
        if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid shell process ID');
        await privateDirectory(this.directory);
        const folder = join(this.directory, id);
        if (!existsSync(folder)) throw new Error('Unknown shell process ID');
        await privateDirectory(folder);
        let request: ShellRequest | undefined;
        for (let attempt = 0; attempt < 40; attempt++) {
            try { request = await readReceipt<ShellRequest>(join(folder, 'request.json')); break; }
            catch (error) { if (!['ENOENT','EAGAIN'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; await new Promise(resolve => setTimeout(resolve, 25)); }
        }
        if (!request) throw new Error('Shell launch preparation is unresolved; do not relaunch');
        if (!Number.isSafeInteger(request.createdAt) || request.createdAt < 0 || typeof request.command !== 'string' || typeof request.cwd !== 'string') throw new Error('Invalid shell request');
        if (request.owner !== this.owner(options) || request.id !== id || request.version !== 1) throw new Error('Shell process belongs to another session');
        return { folder, request };
    }
    async launch(args: Record<string, unknown>, options?: ToolCallOptions): Promise<ToolCallResult> {
        if (options?.signal?.aborted) return { ok: false, content: 'Cancelled before shell launch', errorKind: 'cancelled' };
        await privateDirectory(this.directory);
        const owner = this.owner(options), id = digest([owner, options?.sessionId ?? '', options?.callId ?? randomUUID()]);
        const { yield_after_ms, timeout_ms, ...execution } = args;
        const requestHash = digest(execution);
        const folder = join(this.directory, id);
        if (options?.signal?.aborted) return { ok: false, content: 'Cancelled before shell launch', errorKind: 'cancelled' };
        let fresh = true;
        try { await mkdir(folder, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; fresh = false; }
        try {
        if (fresh) {
            const request: ShellRequest = { version: 1, id, owner, createdAt: Date.now(), sessionId: options?.sessionId, callId: options?.callId, command: args.command as string, cwd: args.cwd as string,
                ...(args.env ? { env: args.env as Record<string, string> } : {}),
                ...(args.execution_timeout_ms === undefined ? {} : { executionTimeoutMs: args.execution_timeout_ms as number }), requestHash };
            await writeReceipt(join(folder, 'request.json'), request, true);
            // Prepared identity survives an interrupted handshake. Never relaunch it.
            await writeReceipt(receiptPath(folder), { status: 'running', startedAt: Date.now() });
            const local = fileURLToPath(new URL('./shell-supervisor.js', import.meta.url));
            const entry = existsSync(local) ? local : resolve(dirname(local), '../../dist/runtime/harness/shell-supervisor.js');
            const worker = spawn(process.execPath, [entry, folder, this.outputDirectory], { detached: process.platform !== 'win32', stdio: 'ignore' });
            worker.on('error', () => { void writeReceipt(join(folder, 'launcher.json'), { failed: true }).catch(() => {}); });
            if (worker.pid) await writeReceipt(join(folder, 'launcher.json'), { pid: worker.pid, birth: processIdentity(worker.pid) });
            worker.unref();
        } else {
            const existing = await this.request(id, options);
            if (existing.request.requestHash !== requestHash) throw new Error('Shell call identity reused with different execution arguments');
        }
        const result = await this.poll({ id, yield_after_ms: args.yield_after_ms ?? args.timeout_ms ?? 1000 }, options);
        const status = (result.data as { status: string }).status;
        return status === 'stopped' ? { ...result, ok: false, errorKind: 'unknown' } : ['failed', 'cancelled', 'deadline_exceeded'].includes(status) ? { ...result, ok: false, errorKind: 'runtime' } : result;
        } catch (error) {
            if (String(error).includes('identity reused')) throw error;
            return { ok: false, errorKind: 'unknown', content: `Shell launch/observation unresolved for ${id}; do not relaunch. ${String(error)}`, data: { processId: id, status: 'unknown' } };
        }
    }
    async poll(args: Record<string, unknown>, options?: ToolCallOptions): Promise<ToolCallResult> {
        const id = args.id as string, { folder, request } = await this.request(id, options);
        try {
        const deadline = Date.now() + (args.yield_after_ms as number ?? 0);
        let receipt: ShellReceipt;
        do {
            try { receipt = await readEffectiveShellReceipt(folder); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                receipt = { status: 'running', startedAt: request.createdAt };
            }
            if (receipt.status !== 'running' || options?.signal?.aborted || Date.now() >= deadline) break;
            await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
        } while (true);
        if (receipt.status === 'running') {
            // Launch handshake may still be pending. Without a durable supervisor
            // identity, keep the uncertainty visible and never repeat launch.
            let pid = receipt.supervisorPid, birth = receipt.supervisorBirth;
            if (!pid) {
                try {
                    const launcher = await readReceipt<{ pid?: number; birth?: string; failed?: boolean }>(join(folder,'launcher.json'));
                    pid = launcher.pid; birth = launcher.birth;
                    if (launcher.failed) receipt = { ...receipt, status:'unknown', reason:'Supervisor launch failed; do not relaunch' };
                } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            }
            let disappeared = false;
            if (pid) {
                const currentBirth = processIdentity(pid);
                if (currentBirth && birth) disappeared = currentBirth !== birth;
                else { try { process.kill(pid,0); } catch (error) { disappeared = (error as NodeJS.ErrnoException).code === 'ESRCH'; } }
            }
            // Elapsed startup time is not proof of loss. A prepared launch with no
            // identity remains inspectable, but never authorizes a second launch.
            if (disappeared) {
                // Completion may have been published between our read and the liveness check.
                const latest = await readEffectiveShellReceipt(folder);
                receipt = latest.status !== 'running' ? latest : { ...latest, status: 'unknown', reason: 'Supervisor disappeared; inspect effects, do not relaunch' };
            }
        }
        let outputPage;
        if (receipt.status === 'running') {
            try {
                const fd = await open(join(folder, 'live-output'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
                try {
                    const info = await fd.stat();
                    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_CAPTURE_BYTES || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error('Invalid live shell output');
                    const buffer = Buffer.alloc(info.size); const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
                    const decoder = new StringDecoder('utf8');
                    outputPage = readTextPage(decoder.write(buffer.subarray(0,bytesRead)), args.offset as number ?? 0, 4000);
                } finally { await fd.close(); }
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        const metadata = receipt.result ? Object.fromEntries(Object.entries(receipt.result).filter(([k]) => k !== 'content')) : {};
        const data = { ...metadata, ...(receipt.status === 'running' && !receipt.supervisorPid ? { phase:'starting' } : {}), ...(outputPage ? { outputPage, outputComplete: false } : {}), processId: id, status: receipt.status, exitCode: receipt.exitCode, signal: receipt.signal,
            ...(receipt.reason ? { reason: receipt.reason } : {}), startedAt: receipt.startedAt, finishedAt: receipt.finishedAt };
        const message = receipt.status === 'running' ? `${receipt.supervisorPid ? 'Command accepted and still running.' : 'Launch recorded; waiting for supervisor startup.'} Inspect with shell_poll({"id":"${id}"}); do not launch again.`
            : receipt.status === 'completed' ? `Exit code: ${receipt.exitCode}`
                : `Command state: ${receipt.status}. Exit code: ${receipt.exitCode ?? 'unavailable'}. Earlier effects are not rolled back.${receipt.reason ? ' ' + receipt.reason : ''}`;
        return { ok: receipt.status !== 'unknown', content: `${receipt.result?.content ?? outputPage?.content ?? ''}${receipt.result?.content || outputPage?.content ? '\n' : ''}${message}`, data,
            ...(receipt.status === 'unknown' ? { errorKind: 'unknown' as const } : {}) };
        } catch (error) {
            return { ok: false, errorKind: 'unknown', content: `Cannot inspect accepted command ${id}; do not relaunch. ${String(error)}`, data: { processId: id, status: 'unknown' } };
        }
    }
    async list(options?: ToolCallOptions): Promise<ToolCallResult> {
        await privateDirectory(this.directory);
        const items = [];
        for (const id of (await readdir(this.directory)).filter(id => /^[a-f0-9]{64}$/.test(id)).sort()) {
            const request = await readReceipt<ShellRequest>(join(this.directory, id, 'request.json'));
            if (!Number.isSafeInteger(request.createdAt) || request.createdAt < 0 || typeof request.command !== 'string' || typeof request.cwd !== 'string') throw new Error('Invalid shell request');
            if (request.owner !== this.owner(options)) continue;
            const result = await this.poll({ id }, options);
            items.push(result.data);
        }
        return { ok: true, content: JSON.stringify(items), data: items };
    }
    async wait(args: Record<string, unknown>, options?: ToolCallOptions): Promise<ToolCallResult> {
        for (;;) {
            const result = await this.poll({ id: args.id, yield_after_ms: 1000 }, options);
            if ((result.data as { status?: string }).status !== 'running' || options?.signal?.aborted) return result;
        }
    }
    async cancel(args: Record<string, unknown>, options?: ToolCallOptions): Promise<ToolCallResult> {
        const { folder } = await this.request(args.id as string, options);
        const observed = await this.poll({ id: args.id }, options);
        if ((observed.data as { status: string }).status === 'unknown') return { ...observed, content: 'Supervisor is unavailable; cancellation cannot be confirmed. Inspect the retained execution identity and effects.' };
        if ((observed.data as { status: string }).status !== 'running') return observed;
        try { const fd = await open(join(folder, 'cancel'), 'wx', 0o600); await fd.sync(); await fd.close(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        return { ok: true, content: 'Cancellation requested for this execution. Poll its terminal receipt; earlier effects are not rolled back.', data: { processId: args.id, cancellationRequested: true } };
    }
}
