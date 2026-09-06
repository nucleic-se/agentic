import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fork, execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { SessionEvent, SessionRecord } from './types.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = fileURLToPath(new URL('./testing/crash-process.mjs', import.meta.url));
interface Reply { type: string; error?: string; record: SessionRecord; events: SessionEvent[]; requestId?: number }
let temporary: string, compiled: string;
let requestId = 0;
const children = new Set<ChildProcess>();
function launch(directory: string, mode: string) {
    const child = fork(fixture, [compiled, directory, mode], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.add(child);
    return child;
}
function receive(child: ChildProcess, type: string, id?: number): Promise<Reply> {
    return new Promise((resolve, reject) => {
        const onMessage = (message: Reply) => {
            if (message.type !== type || (id !== undefined && message.requestId !== id)) return;
            cleanup(); resolve(message);
        };
        const onExit = (code: number | null, signal: string | null) => { cleanup(); reject(new Error(`Fixture exited before ${type}: ${code}/${signal}`)); };
        const cleanup = () => { child.off('message', onMessage); child.off('exit', onExit); child.off('error', onError); };
        const onError = (error: Error) => { cleanup(); reject(error); };
        child.on('message', onMessage); child.once('exit', onExit); child.once('error', onError);
    });
}
function command(child: ChildProcess, command: string, fields = {}) {
    const id = ++requestId, reply = receive(child, 'reply', id);
    child.send({ command, requestId: id, ...fields });
    return reply;
}
async function kill(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    children.delete(child);
}
async function counts(directory: string) {
    const lines = (await readFile(join(directory, 'effects.log'), 'utf8')).trim().split('\n');
    return { models: lines.filter(line => line === 'model').length, effects: lines.filter(line => line === 'effect').length };
}

// Compile into an isolated directory so this gate works with dist/ absent or stale.
beforeAll(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'agentic-crash-gate-'));
    compiled = join(temporary, 'compiled');
    await promisify(execFile)(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.json'), '--outDir', compiled, '--declaration', 'false', '--declarationMap', 'false', '--sourceMap', 'false']);
    await symlink(join(root, 'node_modules'), join(compiled, 'node_modules'), 'dir');
    await writeFile(join(compiled, 'package.json'), '{"type":"module"}');
}, 30_000);
afterAll(async () => {
    await Promise.all([...children].map(kill));
    if (temporary) await rm(temporary, { recursive: true, force: true });
});

describe('actual process crash and SQLite recovery', () => {
    it.each(['before-dispatch', 'after-effect', 'after-receipt'])('recovers safely at %s', async mode => {
        const directory = await mkdtemp(join(temporary, `${mode}-`));
        const first = launch(directory, mode);
        await receive(first, 'barrier');
        await kill(first); // SIGKILL, no close(), signal handler, or graceful journal flush.
        const effects = mode === 'before-dispatch' ? 0 : 1;
        expect(await counts(directory)).toEqual({ models: 1, effects });
        const restarted = launch(directory, 'recover');
        try {
            const recovered = await receive(restarted, 'ready');
            expect(recovered.record.status).toBe('interrupted');
            expect(recovered.events.at(-1)?.type).toBe('run.recovered');
            const operation = recovered.record.operations.find(item => item.kind === 'tool')!;
            expect(operation.status).toBe(mode === 'after-receipt' ? 'completed' : 'unknown');
            expect(recovered.record.operations.some(item => item.status === 'intent')).toBe(false);
            // Opening the store and recovering never causes another model or external call.
            expect(await counts(directory)).toEqual({ models: 1, effects });
            if (mode !== 'after-receipt') {
                const blocked = await command(restarted, 'resume');
                expect(blocked.error).toContain('Unknown tool outcome');
                expect(await counts(directory)).toEqual({ models: 1, effects });
                const resolution = await command(restarted, 'resolve', {
                    evidence: effects ? 'Durable external ledger contains the write' : 'Durable external ledger confirms no dispatch occurred',
                    result: effects ? { ok: true, content: 'written' } : { ok: false, content: 'No write occurred', errorKind: 'runtime' },
                });
                expect(resolution.error).toBeUndefined();
                expect(resolution.events.at(-1)?.type).toBe('tool.resolved');
            }
            const resumed = await command(restarted, 'resume');
            expect(resumed.error).toBeUndefined();
            expect(resumed.record.status).toBe('idle');
            expect(resumed.record.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'done' });
            expect(await counts(directory)).toEqual({ models: 2, effects });
            const exited = once(restarted, 'exit');
            await command(restarted, 'close'); await exited; children.delete(restarted);
        } finally { await kill(restarted); }
    }, 15_000);
});
