import { spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { IToolPolicy } from '../../contracts/IToolPolicy.js';
import type { IValidatedToolRuntime, ToolCallOptions, ToolCallResult } from '../../contracts/tool-runtime.js';
import { FsToolRuntime } from '../../tools/fs.js';
import { SearchToolRuntime } from '../../tools/search.js';
import { ShellToolRuntime } from '../../tools/shell.js';
import { AgentContextAssembler } from '../AgentContextAssembler.js';
import type { ContextStrategy, LoopServices, LoopStrategy } from './types.js';

async function drain(services: LoopServices, mode: 'steer' | 'enqueue'): Promise<boolean> {
    const messages = await services.takeQueued(mode);
    return messages.length > 0;
}

export function conversationalLoop(options: { maxTurns?: number } = {}): LoopStrategy {
    const maxTurns = options.maxTurns ?? 20;
    if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new RangeError('maxTurns must be a positive safe integer');
    return { async run(services) {
        for (let turn = 0; turn < maxTurns; turn++) {
            services.signal.throwIfAborted();
            await drain(services, 'steer');
            const response = await services.model.request(await services.context());
            if (response.stopReason === 'max_tokens') throw new Error('Model output reached its token limit');
            const calls = response.message.toolCalls ?? [];
            if (response.stopReason === 'tool_use' && !calls.length) throw new Error('Model requested tools without tool calls');
            if (response.stopReason !== 'tool_use' && calls.length) throw new Error('Model returned tool calls with an incompatible stop reason');
            if (new Set(calls.map(call => call.id)).size !== calls.length) throw new Error('Model returned duplicate tool call IDs');
            if (response.stopReason === 'tool_use') {
                // Effect services commit their transcript projections atomically.
                await services.tools.executeBatch(calls);
                continue;
            }
            if (await drain(services, 'steer')) continue;
            if (await drain(services, 'enqueue')) continue;
            return;
        }
        throw new Error(`Reached turn limit of ${maxTurns}`);
    } };
}

/** An explicit planning model operation precedes the ordinary tool-capable loop. */
export function planningLoop(options: { maxTurns?: number } = {}): LoopStrategy {
    const conversation = conversationalLoop(options);
    return { async run(services) {
        services.signal.throwIfAborted();
        await drain(services, 'steer');
        const context = await services.context();
        const plan = await services.model.request({ ...context, tools: [],
            system: `${context.system ?? ''}\nProduce a concise plan for the user's task. Do not execute tools. A subsequent step will carry out the plan.` });
        if (plan.stopReason === 'max_tokens' || plan.stopReason === 'tool_use' || plan.message.toolCalls?.length) {
            throw new Error('Planning response must be complete and contain no tool calls');
        }
        await conversation.run(services);
    } };
}

export function fullHistoryContext(system = ''): ContextStrategy {
    return { async assemble(messages, signal, options) { signal.throwIfAborted(); return { system: options?.system ?? system, messages: structuredClone(messages) }; } };
}

export function budgetedContext(system: string, tokenBudget: number): ContextStrategy {
    if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1) throw new RangeError('tokenBudget must be a positive safe integer');
    const assembler = new AgentContextAssembler({ systemPrompt: system, tokenBudget });
    return { async assemble(messages, signal, options) {
        signal.throwIfAborted();
        const input = [...messages].reverse().find(message => message.role === 'user')?.content ?? '';
        const result = await assembler.assemble({ messages: structuredClone(messages), userInput: input, tokenBudget, signal, ...options });
        signal.throwIfAborted();
        return result;
    } };
}

const filePath = z.string().min(1);
const schemas: Record<string, z.ZodType<Record<string, unknown>>> = {
    fs_read: z.object({ path: filePath, encoding: z.enum(['utf8', 'base64']).optional(), offset: z.number().int().positive().optional(), limit: z.number().int().positive().optional() }).strict(),
    fs_write: z.object({ path: filePath, content: z.string().max(262144), append: z.boolean().optional() }).strict(),
    fs_list: z.object({ path: filePath, recursive: z.boolean().optional() }).strict(),
    fs_delete: z.object({ path: filePath }).strict(),
    fs_move: z.object({ from: filePath, to: filePath }).strict(),
    fs_patch: z.object({ path: filePath, patches: z.array(z.object({ search: z.string().min(1), replace: z.string() }).strict()).min(1).max(100) }).strict(),
    search_grep: z.object({ pattern: z.string().min(1).max(4096), path: filePath.optional(), include: z.string().optional(), case_sensitive: z.boolean().optional(), literal: z.boolean().optional(), context_lines: z.number().int().min(0).max(10).optional(), max_results: z.number().int().min(1).max(100).optional(), output: z.enum(['content', 'files_only', 'count']).optional() }).strict(),
    search_find: z.object({ pattern: z.string().min(1), path: filePath.optional() }).strict(),
    shell_run: z.object({ command: z.string().min(1), cwd: filePath.optional(), timeout_ms: z.number().int().min(1).max(120000).optional(), env: z.record(z.string(), z.string()).optional() }).strict(),
};

function confined(root: string, target: string): string {
    const absolute = path.resolve(root, target);
    const relative = path.relative(root, absolute);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Path escapes working root');
    let current = root;
    for (const part of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        try { if (lstatSync(current).isSymbolicLink()) throw new Error('Symbolic links are not allowed'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return absolute;
}

function runShell(root: string, args: Record<string, unknown>, options?: ToolCallOptions): Promise<ToolCallResult> {
    if (options?.signal?.aborted) return Promise.resolve({ ok: false, content: 'Cancelled before execution', errorKind: 'cancelled' });
    const cwd = confined(root, args.cwd as string ?? '.');
    return new Promise(resolve => {
        const child = spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
            process.platform === 'win32' ? ['/d', '/s', '/c', args.command as string] : ['-c', args.command as string],
            { cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...args.env as Record<string, string> } });
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        let stopped: 'cancelled' | 'timeout' | undefined;
        let finished = false;
        const capture = (data: Buffer) => {
            const remaining = 65536 - size;
            if (data.length > remaining) truncated = true;
            if (remaining > 0) { const chunk = data.subarray(0, remaining); chunks.push(chunk); size += chunk.length; }
        };
        const stop = (reason: 'cancelled' | 'timeout') => {
            stopped ??= reason;
            try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); }
        };
        const abort = () => stop('cancelled');
        const timer = setTimeout(() => stop('timeout'), args.timeout_ms as number ?? 30000);
        const finish = (code: number | null, error?: Error) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            options?.signal?.removeEventListener('abort', abort);
            const output = Buffer.concat(chunks).toString('utf8') + (truncated ? '\n[output truncated]' : '');
            resolve({ ok: !stopped && !error && code === 0,
                content: `${output}${output ? '\n' : ''}${stopped ?? error?.message ?? `Exit code: ${code}`}`,
                ...((stopped || error || code !== 0) ? { errorKind: stopped ?? 'runtime' as const } : {}),
                data: { exitCode: code, truncated } });
        };
        child.stdout.on('data', capture);
        child.stderr.on('data', capture);
        child.on('error', error => finish(null, error));
        child.on('close', code => finish(code));
        options?.signal?.addEventListener('abort', abort, { once: true });
        if (options?.signal?.aborted) abort();
    });
}

/** Local trusted-code tools. Root checks do not sandbox arbitrary shell commands. */
export function codingToolRuntime(workingRoot: string): IValidatedToolRuntime {
    const root = realpathSync(workingRoot);
    const fs = new FsToolRuntime(root);
    const search = new SearchToolRuntime(root);
    const shell = new ShellToolRuntime(root);
    const definitions = [...fs.tools(), ...search.tools(), ...shell.tools()];
    const runtime: IValidatedToolRuntime = {
        tools: () => structuredClone(definitions),
        validate(name, args) {
            const schema = schemas[name];
            if (!schema) return { ok: false, result: { ok: false, content: `Unknown tool: ${name}`, errorKind: 'validation' } };
            const parsed = schema.safeParse(args);
            if (!parsed.success) return { ok: false, result: { ok: false, content: parsed.error.message, errorKind: 'validation' } };
            try {
                for (const key of ['path', 'from', 'to', 'cwd']) if (typeof parsed.data[key] === 'string') confined(root, parsed.data[key] as string);
            } catch (error) { return { ok: false, result: { ok: false, content: String(error), errorKind: 'validation' } }; }
            return { ok: true, args: parsed.data };
        },
        async call(name, args, options) {
            try {
                const checked = runtime.validate(name, args);
                if (!checked.ok) return checked.result;
                if (options?.authorizedArgs && !isDeepStrictEqual(checked.args, options.authorizedArgs)) return { ok: false, content: 'Arguments differ from authorization', errorKind: 'policy' };
                if (options?.signal?.aborted) return { ok: false, content: 'Cancelled', errorKind: 'cancelled' };
                if (name === 'shell_run') return await runShell(root, checked.args, options);
                return await (name.startsWith('fs_') ? fs : search).call(name, checked.args);
            } catch (error) { return { ok: false, content: String(error), errorKind: 'runtime' }; }
        },
        trustTierFor: () => 'standard',
    };
    return runtime;
}

export function defaultCodingPolicy(): IToolPolicy {
    const readTools = new Set(['fs_read', 'fs_list', 'search_grep', 'search_find']);
    return { async evaluate(context) {
        return readTools.has(context.name) ? { kind: 'allow' }
            : { kind: 'confirm', reason: `Approve ${context.name} with these exact arguments` };
    } };
}
