import type { Message } from '../../contracts/llm.js';
import { open, opendir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep, normalize } from 'node:path';

export interface ProjectInstruction {
    /** Workspace-relative source file and the directory it governs. */
    path: string;
    directory: string;
    content: string;
}

/** Discover scoped instructions once, or load only explicitly selected directory scopes. */
export async function readProjectInstructions(workspace: string, directories?: readonly string[], signal?: AbortSignal): Promise<ProjectInstruction[]> {
    const root = await realpath(workspace);
    if (directories === undefined) {
        const found: string[] = [], pending = [root];
        const excluded = new Set(['.git', 'node_modules', '.data', '.cache']);
        while (pending.length) {
            signal?.throwIfAborted();
            const directory = pending.pop()!;
            for await (const entry of await opendir(directory)) {
                signal?.throwIfAborted();
                if (entry.name === 'AGENTS.md') found.push(directory);
                if (entry.isDirectory() && !excluded.has(entry.name)) pending.push(join(directory, entry.name));
            }
        }
        directories = found;
    }
    const withinRoot = (path: string) => {
        const rel = relative(root, path);
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
            throw new Error('Instruction scope escapes the workspace');
        return rel;
    };
    const scopes = new Set<string>([root]);
    for (const directory of directories) {
        let current = resolve(root, directory);
        withinRoot(current);
        while (current !== root) { scopes.add(current); current = dirname(current); }
    }
    const instructions: ProjectInstruction[] = [];
    let remaining = 65536;
    for (const directory of [...scopes].sort((a, b) => a.length - b.length || a.localeCompare(b))) {
        signal?.throwIfAborted();
        const path = join(directory, 'AGENTS.md');
        let source: string;
        try { source = await realpath(path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        withinRoot(source);
        const file = await open(source, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
        try {
            if (!(await file.stat()).isFile()) throw new Error(`Project instructions must be a regular file: ${path}`);
            const buffer = Buffer.alloc(remaining + 1);
            let size = 0;
            while (size < buffer.length) {
                signal?.throwIfAborted();
                const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
                if (!bytesRead) break;
                size += bytesRead;
            }
            if (size > remaining) throw new Error('Project instructions exceed the 64 KiB combined limit');
            remaining -= size;
            const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
            instructions.push({ path: relative(root, path), directory: relative(root, directory) || '.', content });
        } finally { await file.close(); }
    }
    return instructions;
}

/** Only paths the task has actually used select nested scope bodies. */
export function projectInstructionTargets(messages: readonly Message[], workspace?: string): string[] {
    return messages.flatMap(message => message.role === 'assistant' ? (message.toolCalls ?? []).flatMap(call =>
        ['path', 'cwd'].flatMap(key => {
            const value = call.args[key];
            if (typeof value !== 'string') return [];
            return [normalize(workspace && isAbsolute(value) ? relative(workspace, value) : value).split(sep).join('/')];
        })) : []);
}

export function projectInstructionText(instructions: readonly ProjectInstruction[], targets: readonly string[] = []): string {
    if (!instructions.length) return '';
    const selected = instructions.filter(instruction => instruction.directory === '.' || targets.some(target =>
        target === instruction.directory || target.startsWith(instruction.directory + '/')));
    const remaining = instructions.filter(instruction => !selected.includes(instruction));
    return '\n\nProject instructions govern their directories; deeper scopes refine outer scopes. Read applicable AGENTS.md before editing.\n' +
        selected.map(instruction => `\nSource: ${instruction.path}\nScope: ${instruction.directory}\n${instruction.content}`).join('\n') +
        (remaining.length ? '\nOther instruction scopes (read with fs_read when working there):\n' + remaining.map(instruction => instruction.path).join('\n') : '');
}
