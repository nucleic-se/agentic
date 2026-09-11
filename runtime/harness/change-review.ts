import { spawn } from 'node:child_process';
import { killProcessGroup } from './process.js';
import type { ToolCallResult } from '../../contracts/tool-runtime.js';
import { projectToolOutput } from '../ToolOutput.js';
import { FileToolOutputStore, MAX_CAPTURE_BYTES } from './output.js';

class GitFailure extends Error {
    constructor(message: string, readonly kind: 'runtime' | 'cancelled' | 'timeout' | 'unknown') { super(message); }
}

function executeGit(root: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const child = spawn('git', ['--no-pager', ...args], {
            cwd: root, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        });
        const stdout: Buffer[] = [], stderr: Buffer[] = [];
        let bytes = 0, failure: Error | undefined;
        const stop = (error: Error) => { failure ??= error; killProcessGroup(child); };
        const abort = () => stop(new GitFailure('Change review cancelled', 'cancelled'));
        const timer = setTimeout(() => stop(new GitFailure('Change review timed out', 'timeout')), 30000);
        const capture = (target: Buffer[]) => (chunk: Buffer) => {
            if (failure) return;
            bytes += chunk.length;
            if (bytes > MAX_CAPTURE_BYTES) stop(new GitFailure('Change review exceeds the 8 MiB capture limit; no complete patch was saved', 'unknown'));
            else target.push(chunk);
        };
        child.stdout.on('data', capture(stdout));
        child.stderr.on('data', capture(stderr));
        child.on('error', error => { failure ??= error; });
        child.on('close', code => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            if (failure) reject(failure);
            else if (code !== 0) reject(new GitFailure(Buffer.concat(stderr).toString('utf8') || `Git exited with code ${code}`, 'runtime'));
            else resolve(Buffer.concat(stdout));
        });
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
    });
}

/** Explicit Git review for the coding composition; no command parsing or completion policy. */
async function collectReview(root: string, store: FileToolOutputStore, base: string, signal?: AbortSignal): Promise<ToolCallResult> {
    const git = async (args: string[]) => {
        signal?.throwIfAborted();
        const stdout = await executeGit(root, args, signal);
        // Saved text must not silently replace invalid source bytes.
        return new TextDecoder('utf-8', { fatal: true }).decode(stdout);
    };
    // Resolve first so an argument cannot become a Git option, path, or moving ref.
    const commit = (await git(['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`])).trim();
    const diff = ['diff', '--relative', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--ignore-submodules=none'];
    const stats = await git([...diff, '--stat', commit, '--', '.']);
    const withoutWhitespace = await git([...diff, '-w', '--stat', commit, '--', '.']);
    const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z', '--', '.'])).split('\0').filter(Boolean);
    const patch = await git([...diff, '--binary', '--full-index', commit, '--', '.']);
    const summary = `Tracked working-tree changes against ${commit} (includes staged and unstaged edits):\n`
        + (stats || 'No tracked changes.\n')
        + '\nIgnoring whitespace (-w; textual comparison, not semantic equivalence):\n'
        + (withoutWhitespace || 'No tracked differences under -w. Whitespace can still affect behavior.\n')
        + '\nUntracked, non-ignored paths (not included in the patch; inspect with fs_read):\n'
        + (untracked.length ? untracked.map(name => JSON.stringify(name)).join('\n') + '\n' : 'None.\n')
        + '\nGit observations are sequential; concurrent edits can change the working tree during review. These statistics do not establish task fulfillment.\n';
    const saved = summary + '\nTracked patch:\n' + patch;
    if (Buffer.byteLength(saved) > MAX_CAPTURE_BYTES) throw new Error('Change review exceeds the 8 MiB capture limit; review a smaller workspace. No complete patch was saved.');
    signal?.throwIfAborted();
    const outputId = await store.save(saved);
    const reference = `read_output({"id":"${outputId}","offset":0})`;
    const patchOffset = summary.length + '\nTracked patch:\n'.length;
    return { ok: true, content: (projectToolOutput(summary, reference, 3000) ?? summary)
        + `\nSaved review: ${reference}\nExact tracked patch: read_output({"id":"${outputId}","offset":${patchOffset}}). Continue until eof.`,
        data: { outputId, patchOffset, base: commit, untrackedCount: untracked.length } };
}

export async function reviewChanges(root: string, store: FileToolOutputStore, base: string, signal?: AbortSignal): Promise<ToolCallResult> {
    try { return await collectReview(root, store, base, signal); }
    catch (error) {
        return { ok: false, content: String(error), errorKind: error instanceof GitFailure ? error.kind : signal?.aborted ? 'cancelled' : 'runtime' };
    }
}
