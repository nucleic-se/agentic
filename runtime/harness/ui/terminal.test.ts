import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
// Exercise the shipped search worker; npm test builds first.
import { startTerminalUi } from '../../../dist/runtime/harness/ui/terminal.js';
import type { SessionClient, SessionRecord } from '../types.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function fixture() {
    const input = new PassThrough(), output = new PassThrough();
    let text = '';
    output.on('data', chunk => { text += chunk.toString(); });
    const session = (id: string, title: string): SessionRecord => ({ id, title, status: 'idle', revision: 0,
        createdAt: 0, updatedAt: 0, messages: [], operations: [], approvals: [], commandIds: [], queue: [],
        usage: { inputTokens: 12, outputTokens: 4 }, composition: 'test' });
    const sessions = [session('first', 'Alpha task'), session('second', 'Beta task')];
    const detach = vi.fn();
    const client = { create: vi.fn(async () => sessions[0]), get: vi.fn(async (id: string) => {
        const found = sessions.find(item => item.id === id);
        if (!found) throw new Error('Session not found');
        return found;
    }), list: vi.fn(async () => sessions), subscribe: vi.fn(() => detach), submit: vi.fn(async () => {}),
    resume: vi.fn(async () => {}), cancel: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    return { input, output, text: () => text, client, detach, api: client as unknown as SessionClient };
}

it('searches sessions, navigates without resuming, and reports current usage', async () => {
    const f = fixture();
    const close = await startTerminalUi(f.api, f); cleanups.push(close);
    f.input.write('/sessions bEtA\n/use second\n/status\n');
    await vi.waitFor(() => expect(f.text()).toContain('Tokens: 12 input / 4 output'));
    expect(f.text()).toContain('second  idle  Beta task');
    expect(f.text()).not.toContain('first  idle  Alpha task');
    expect(f.client.list).toHaveBeenCalledWith({ limit: 1000 });
    expect(f.client.resume).not.toHaveBeenCalled();
    f.input.write('continue\n');
    await vi.waitFor(() => expect(f.client.submit).toHaveBeenCalledWith('second', 'continue', expect.anything()));
    close(); expect(f.detach).toHaveBeenCalledOnce();
    expect(f.client.cancel).not.toHaveBeenCalled();
    expect(f.client.close).not.toHaveBeenCalled();
});

it('discovers allowed files and attaches only explicit path references to the next message', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agentic-terminal-')); cleanups.push(() => rm(workspace, { recursive: true, force: true }));
    await writeFile(join(workspace, 'source file.ts'), 'PRIVATE FILE CONTENT');
    await writeFile(join(workspace, '.env'), 'SECRET');
    await mkdir(join(workspace, 'node_modules'));
    await writeFile(join(workspace, 'node_modules/dependency.ts'), 'dependency');
    await symlink(join(workspace, 'source file.ts'), join(workspace, 'link.ts'));
    const f = fixture();
    const close = await startTerminalUi(f.api, { ...f, workspace }); cleanups.push(close);
    f.input.write('/files\n/file .env\n/file link.ts\n/file ../outside\n/file source file.ts\n');
    await vi.waitFor(() => expect(f.text()).toContain('added to your next message'));
    expect(f.text()).toContain('source file.ts');
    expect(f.text()).not.toContain('dependency.ts');
    expect(f.text()).not.toContain('PRIVATE FILE CONTENT');
    expect(f.text()).toContain('excluded by workspace search rules');
    expect(f.text()).toContain('Symbolic links cannot be attached');
    expect(f.text()).toContain('Choose a file inside the workspace');
    expect(f.client.submit).not.toHaveBeenCalled();
    f.input.write('inspect this\nsecond message\n');
    await vi.waitFor(() => expect(f.client.submit).toHaveBeenCalledTimes(2));
    expect(f.client.submit.mock.calls[0]).toEqual(['first', 'inspect this\n\nWorkspace file references (paths only):\n"source file.ts"', expect.anything()]);
    expect(f.client.submit.mock.calls[1]).toEqual(['first', 'second message', expect.anything()]);
});

it('keeps file discovery opt-in and does not submit rejected commands', async () => {
    const f = fixture(); const close = await startTerminalUi(f.api, f); cleanups.push(close);
    f.input.write('/files\n');
    await vi.waitFor(() => expect(f.text()).toContain('Workspace discovery is not enabled'));
    expect(f.client.submit).not.toHaveBeenCalled();
});
