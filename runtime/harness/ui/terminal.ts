import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import type { Readable, Writable } from 'node:stream';
import type { Extension, SessionClient, SessionRecord } from '../types.js';

export interface TerminalUiOptions {
    input?: Readable;
    output?: Writable;
    sessionId?: string;
}

/** A detachable line UI. Commands remain available while model/tool work runs. */
export async function startTerminalUi(client: SessionClient, options: TerminalUiOptions = {}): Promise<() => void> {
    const output = options.output ?? process.stdout;
    const input = options.input ?? process.stdin;
    const write = (text: string) => { output.write(stripVTControlCharacters(text)); };
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
            } else if (message.role === 'tool_result') write(`[${message.toolName ?? 'tool'}${message.isError ? ' failed' : ''}] ${message.content.slice(0, 500)}\n`);
        }
        renderedMessages = session.messages.length;
        if (session.error) write(`\n${session.status}: ${session.error}\n`);
    };
    const unsubscribe = client.subscribe(update => {
        if (closed || update.sessionId !== current.id) return;
        if (update.type === 'delta') { sawDelta = true; write(update.text ?? ''); return; }
        const id = current.id;
        updates = updates.then(async () => {
            const session = await client.get(id);
            if (!closed && current.id === id) show(session);
        }).catch(error => write(`\n${String(error)}\n`));
    });
    const attach = (session: SessionRecord) => {
        current = session;
        sawDelta = false;
        renderedMessages = 0;
        shownApprovals.clear();
        write(`\nSession ${session.id}: ${session.title}\n`);
        show(session);
    };
    const close = () => { if (closed) return; closed = true; unsubscribe(); lines.close(); };
    let commands = Promise.resolve();
    const handle = async (line: string) => {
        if (closed || !line.trim()) return;
        const [command, ...args] = line.trim().split(/\s+/);
        if (command === '/quit') { close(); return; }
        if (command === '/new') { attach(await client.create(args.join(' ') || undefined)); return; }
        if (command === '/sessions') {
            for (const session of await client.list()) write(`${session.id}  ${session.status}  ${session.title}\n`);
            return;
        }
        if (command === '/resume') {
            if (!args[0]) throw new Error('Usage: /resume SESSION_ID');
            attach(await client.get(args[0]));
            // Resuming reconnects and continues recoverable work according to host policy.
            void client.resume(current.id).catch(error => write(`\n${String(error)}\n`));
            return;
        }
        if (command === '/fork') { attach(await client.fork(current.id)); return; }
        if (command === '/cancel') { await client.cancel(current.id); return; }
        if (command === '/approve') {
            if (!args[0] || !['y', 'n'].includes(args[1])) throw new Error('Usage: /approve APPROVAL_ID y|n');
            await client.approve(current.id, args[0], args[1] === 'y');
            return;
        }
        if (command.startsWith('/')) throw new Error('Commands: /new, /resume ID, /fork, /sessions, /cancel, /approve ID y|n, /quit');
        // Do not await the run: an approval/cancellation command must still be readable.
        void client.submit(current.id, line, { commandId: randomUUID(), mode: 'steer' })
            .catch(error => write(`\n${String(error)}\n`));
    };
    lines.on('line', line => {
        commands = commands.then(() => handle(line)).catch(error => write(`\n${String(error)}\n`));
    });
    lines.on('SIGINT', () => { void client.cancel(current.id).catch(error => write(`\n${String(error)}\n`)); });
    lines.on('close', close);
    write('Agentic terminal — /new /resume ID /fork /sessions /cancel /approve ID y|n /quit\n');
    attach(current);
    return close;
}

export function terminalUiExtension(options: TerminalUiOptions = {}): Extension {
    return { id: 'agentic.ui.terminal', version: '1.0.0', apiVersion: 1,
        activate: client => startTerminalUi(client, options) };
}
