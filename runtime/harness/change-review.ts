import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolCallResult } from '../../contracts/tool-runtime.js';
import { projectToolOutput } from '../ToolOutput.js';
import { FileToolOutputStore, MAX_CAPTURE_BYTES } from './output.js';

const execute = promisify(execFile);

/** Explicit Git review for the coding composition; no command parsing or completion policy. */
export async function reviewChanges(root: string, store: FileToolOutputStore, base: string, signal?: AbortSignal): Promise<ToolCallResult> {
    const git = async (args: string[]) => {
        signal?.throwIfAborted();
        const { stdout } = await execute('git', ['--no-pager', ...args], {
            cwd: root, signal, timeout: 30000, maxBuffer: MAX_CAPTURE_BYTES, encoding: 'buffer',
            env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        });
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
