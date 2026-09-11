import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import { lstat, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { SearchToolRuntime } from '../../../tools/search.js';
import type { Readable, Writable } from 'node:stream';
import type { Extension, SessionClient, SessionRecord } from '../types.js';

export interface TerminalUiOptions {
    input?: Readable;
    output?: Writable;
    sessionId?: string;
    /** Enable bounded workspace discovery and explicit references; file contents are never attached. */
    workspace?: string;
}

/** A detachable line UI. Commands remain available while model/tool work runs. */
export async function startTerminalUi(client: SessionClient, options: TerminalUiOptions = {}): Promise<() => void> {
    const output = options.output ?? process.stdout;
    const input = options.input ?? process.stdin;
    const workspace = options.workspace ? await realpath(options.workspace) : undefined;
    const search = workspace ? new SearchToolRuntime(workspace, { maxOutputBytes: 8000 }) : undefined;
    const discovery = new AbortController();
    const references = new Set<string>();
    const write = (text: string) => {
        if (!closed) output.write(stripVTControlCharacters(text));
    };
    let current = options.sessionId ? await client.get(options.sessionId) : await client.create();
    let closed = false;
    let sawDelta = false;
    let renderedMessages = current.messages.length;
    let updates = Promise.resolve();
    const shownApprovals = new Set<string>();
    const lines = createInterface({ input, output, terminal: Boolean((output as NodeJS.WriteStream).isTTY) });
    const show = (session: SessionRecord) => {
        for (const approval of session.approvals) {
            if (shownApprovals.has(approval.id)) continue;
            shownApprovals.add(approval.id);
            write(`\nApproval ${approval.id}: ${approval.name}\n${JSON.stringify(approval.args, null, 2)}\n${approval.reason}\n/approve ${approval.id} y|n\n`);
        }
        for (const message of session.messages.slice(renderedMessages)) {
            if (message.role === 'assistant') {
                if (!sawDelta) write(`\n${message.content}\n`);
                else write('\n');
                sawDelta = false;
            } else if (message.role === 'tool_result') {
                write(`[${message.toolName ?? 'tool'}${message.isError ? ' failed' : ''}] ${message.content.slice(0, 500)}\n`);
            }
        }
        renderedMessages = session.messages.length;
        if (session.error) write(`\n${session.status}: ${session.error}\n`);
    };
    const unsubscribe = client.subscribe(update => {
        if (closed || update.sessionId !== current.id) return;
        if (update.type === 'delta') {
            sawDelta = true;
            write(update.text ?? '');
            return;
        }
        const id = current.id;
        updates = updates.then(async () => {
            const session = await client.get(id);
            if (!closed && current.id === id) show(session);
        }).catch(error => write(`\n${String(error)}\n`));
    });
    const attach = (session: SessionRecord) => {
        if (closed) return;
        current = session;
        references.clear();
        sawDelta = false;
        renderedMessages = 0;
        shownApprovals.clear();
        write(`\nSession ${session.id}: ${session.title}\n`);
        show(session);
    };
    const close = () => {
        if (closed) return;
        closed = true;
        discovery.abort();
        unsubscribe();
        lines.close();
    };
    const help = 'Commands: /new [title], /use ID, /resume ID, /fork, /sessions [query], /status, /cancel, /approve ID y|n, /quit'
        + (workspace ? ', /files [name or glob], /file PATH (reference for your next message)' : '');
    let commands = Promise.resolve();
    const handle = async (line: string) => {
        if (closed || !line.trim()) return;
        const [command, ...args] = line.trim().split(/\s+/);
        if (command === '/quit') {
            close();
            return;
        }
        if (command === '/new') {
            attach(await client.create(args.join(' ') || undefined));
            return;
        }
        if (command === '/sessions') {
            const query = args.join(' ').toLowerCase();
            const sessions = await client.list({ limit: 1000 });
            const matches = sessions.filter(session => `${session.id} ${session.title} ${session.status}`.toLowerCase().includes(query));
            for (const session of matches.slice(0, 50)) write(`${session.id === current.id ? '* ' : '  '}${session.id}  ${session.status}  ${session.title}\n`);
            if (!matches.length) write('No matching sessions.\n');
            if (matches.length > 50 || sessions.length === 1000) write('Showing up to 50 matches among the latest 1000 sessions; narrow your query or /use an exact ID.\n');
            return;
        }
        if (command === '/use') {
            if (args.length !== 1) throw new Error('Usage: /use SESSION_ID');
            attach(await client.get(args[0]));
            return;
        }
        if (command === '/status') {
            const session = await client.get(current.id);
            write(`Session ${session.id}: ${session.title}\nState: ${session.status}\nTokens: ${session.usage.inputTokens} input / ${session.usage.outputTokens} output\nQueued: ${session.queue.length}; approvals: ${session.approvals.length}; unknown operations: ${session.operations.filter(operation => operation.status === 'unknown').length}\n`);
            if (session.error) write(`Error: ${session.error}\n`);
            if (references.size) write(`Pending file references: ${[...references].map(file => JSON.stringify(file)).join(', ')}\n`);
            return;
        }
        if (command === '/files' || command === '/file') {
            if (!workspace || !search) throw new Error('Workspace discovery is not enabled for this terminal.');
            const query = args.join(' ');
            if (command === '/files') {
                const result = await search.call('search_find', { pattern: query ? `**/*${query}*` : '**/*' }, { signal: discovery.signal });
                write(`${result.content}\n`);
                return;
            }
            if (!query) throw new Error('Usage: /file PATH');
            if (references.size >= 20) throw new Error('Send your pending references before adding more (maximum 20).');
            const relative = path.relative(workspace, path.resolve(workspace, query));
            if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
                || path.isAbsolute(relative) || /[\x00-\x1f\x7f]/.test(relative)) {
                throw new Error('Choose a file inside the workspace.');
            }
            let target = workspace;
            for (const part of relative.split(path.sep)) {
                target = path.join(target, part);
                if ((await lstat(target)).isSymbolicLink()) throw new Error('Symbolic links cannot be attached.');
            }
            if (!(await lstat(target)).isFile()) throw new Error('Choose a regular file.');
            const result = await search.call('search_find', { path: relative, pattern: '**/*' }, { signal: discovery.signal });
            if (!result.ok || !(result.data as { count?: number } | undefined)?.count) {
                throw new Error('File is unavailable or excluded by workspace search rules.');
            }
            if (closed) return;
            references.add(relative);
            write(`File reference ${JSON.stringify(relative)} added to your next message; contents are not attached.\n`);
            return;
        }
        if (command === '/resume') {
            if (!args[0]) throw new Error('Usage: /resume SESSION_ID');
            attach(await client.get(args[0]));
            // Resuming reconnects and continues recoverable work according to host policy.
            void client.resume(current.id).catch(error => write(`\n${String(error)}\n`));
            return;
        }
        if (command === '/fork') {
            attach(await client.fork(current.id));
            return;
        }
        if (command === '/cancel') {
            await client.cancel(current.id);
            return;
        }
        if (command === '/approve') {
            if (!args[0] || !['y', 'n'].includes(args[1])) throw new Error('Usage: /approve APPROVAL_ID y|n');
            await client.approve(current.id, args[0], args[1] === 'y');
            return;
        }
        if (command.startsWith('/')) throw new Error(help);
        const content = line + (references.size ? `\n\nWorkspace file references (paths only):\n${[...references].map(file => JSON.stringify(file)).join('\n')}` : '');
        references.clear();
        // Do not await the run: an approval/cancellation command must still be readable.
        void client.submit(current.id, content, { commandId: randomUUID(), mode: 'steer' })
            .catch(error => write(`\n${String(error)}\n`));
    };
    lines.on('line', line => {
        commands = commands.then(() => handle(line)).catch(error => write(`\n${String(error)}\n`));
    });
    lines.on('SIGINT', () => {
        void client.cancel(current.id).catch(error => write(`\n${String(error)}\n`));
    });
    lines.on('close', close);
    write(`Agentic terminal — ${help}\n`);
    attach(current);
    return close;
}

export function terminalUiExtension(options: TerminalUiOptions = {}): Extension {
    return {
        id: 'agentic.ui.terminal',
        version: '1.0.0',
        apiVersion: 1,
        activate: client => startTerminalUi(client, options),
    };
}
