/** Independent child supervisor. Parent exit does not cancel commands. A service
 * cgroup stop may kill this process; readers then preserve an unknown outcome. */
import { constants, existsSync, openSync, writeSync, closeSync, fsyncSync } from 'node:fs';
import { MAX_CAPTURE_BYTES } from './output.js';
import { spawn } from 'node:child_process';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { killProcessGroup } from './process.js';
import { FileToolOutputStore, ToolOutputCapture } from './output.js';
import { privateDirectory, readReceipt, writeReceipt, receiptPath, processIdentity, type ShellRequest, type ShellReceipt } from './shell-receipts.js';
async function supervise(directory: string, outputDirectory: string) {
    await privateDirectory(directory);
    // Multiple supervisors for one immutable request must never launch twice.
    const claim = await open(join(directory, 'worker.lock'), 'wx', 0o600);
    await claim.sync(); await claim.close();
    const request = await readReceipt<ShellRequest>(join(directory, 'request.json'));
    const initial: ShellReceipt = { status: 'running', startedAt: Date.now(), supervisorPid: process.pid, supervisorBirth: processIdentity(process.pid) };
    await writeReceipt(receiptPath(directory), initial);
    if (existsSync(join(directory, 'cancel'))) {
        await writeReceipt(receiptPath(directory), { ...initial, status: 'cancelled', finishedAt: Date.now(), exitCode:null, signal:null, dispatched: false, reason: 'Cancelled before command launch; no command dispatched' });
        return;
    }
    const capture = new ToolOutputCapture();
    const output = openSync(join(directory, 'live-output'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let captured = 0;
    const append = (data: Buffer) => {
        capture.append(data);
        const length = Math.min(data.length, MAX_CAPTURE_BYTES - captured);
        if (length > 0) { try { writeSync(output, data, 0, length); captured += length; } catch { /* Terminal capture reports full output through the separate store. */ } }
    };
    const child = spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
        process.platform === 'win32' ? ['/d', '/s', '/c', request.command] : ['-c', request.command],
        { cwd: request.cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...request.env } });
    const identityWritten = new Promise<void>(resolve => {
        child.once('spawn', () => {
            initial.commandPid = child.pid; initial.commandBirth = child.pid ? processIdentity(child.pid) : undefined; initial.dispatched = true;
            void writeReceipt(receiptPath(directory), initial).then(resolve, () => { process.exitCode = 1; resolve(); });
        });
        child.once('error', () => resolve());
    });
    let stopped: 'cancelled' | 'deadline_exceeded' | undefined;
    let finished = false;
    const stop = (reason: typeof stopped) => { stopped ??= reason; killProcessGroup(child); };
    const timer = request.executionTimeoutMs === undefined ? undefined : setTimeout(() => stop('deadline_exceeded'), request.executionTimeoutMs);
    const cancel = setInterval(() => {
        void stat(join(directory, 'cancel')).then(() => { if (!finished) stop('cancelled'); }).catch(error => {
            if (error.code !== 'ENOENT' && !finished) stop('cancelled');
        });
    }, 50);
    const finish = async (code: number | null, signal: string | null, error?: Error) => {
        if (finished) return;
        finished = true; clearInterval(cancel); if (timer) clearTimeout(timer);
        await identityWritten;
        let outputError: string | undefined;
        try { fsyncSync(output); } catch (error) { outputError = String(error); }
        try { closeSync(output); } catch (error) { outputError ??= String(error); }
        const result = await capture.finish(new FileToolOutputStore(outputDirectory));
        await writeReceipt(receiptPath(directory), { ...initial, status: stopped ?? (error || code !== 0 ? 'failed' : 'completed'),
            finishedAt: Date.now(), exitCode: code, signal, ...(outputError ? { outputStorageError: outputError } : {}), ...(error ? { reason: error.message } : {}), result });
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', error => { void finish(null, null, error).catch(() => { process.exitCode = 1; }); });
    child.on('close', (code, signal) => { void finish(code, signal).catch(() => { process.exitCode = 1; }); });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    void supervise(process.argv[2], process.argv[3]).catch(() => { process.exitCode = 1; });
}
