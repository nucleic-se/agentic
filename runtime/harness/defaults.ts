import { fsReadSchema, fsWriteSchema, workspaceFilePath } from '../../tools/fs-schema.js';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { FileToolOutputStore, ToolOutputCapture } from './output.js';
import { reviewChanges } from './change-review.js';
import { lstatSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Message, ToolDefinition } from '../../contracts/llm.js';
import type { IToolPolicy } from '../../contracts/IToolPolicy.js';
import type { IValidatedToolRuntime, ToolCallOptions, ToolCallResult } from '../../contracts/tool-runtime.js';
import { FsToolRuntime } from '../../tools/fs.js';
import { SearchToolRuntime } from '../../tools/search.js';
import { ShellToolRuntime } from '../../tools/shell.js';
import { composeAgentContext, type ContextCompositionOptions } from '../ContextPipeline.js';
import type { ContextStrategy, LoopServices, LoopStrategy } from './types.js';

async function drain(services: LoopServices, mode: 'steer' | 'enqueue'): Promise<boolean> {
    const messages = await services.takeQueued(mode);
    return messages.length > 0;
}

export function conversationalLoop(options: { maxTurns?: number; maxTokens?: number } = {}): LoopStrategy {
    const maxTurns = options.maxTurns ?? 20;
    if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new RangeError('maxTurns must be a positive safe integer');
    if (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1)) throw new RangeError('maxTokens must be a positive safe integer');
    return { async run(services) {
        for (let turn = 0; turn < maxTurns; turn++) {
            services.signal.throwIfAborted();
            await drain(services, 'steer');
            const response = await services.model.request({ ...await services.context(), ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }) });
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
export function planningLoop(options: { maxTurns?: number; maxTokens?: number } = {}): LoopStrategy {
    const conversation = conversationalLoop(options);
    return { async run(services) {
        services.signal.throwIfAborted();
        await drain(services, 'steer');
        const context = await services.context();
        const plan = await services.model.request({ ...context, tools: [], ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
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

export function budgetedContext(system: string | ((messages: readonly Message[], signal: AbortSignal) => Promise<string>), tokenBudget: number, policy: ContextCompositionOptions = {}): ContextStrategy {
    if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1) throw new RangeError('tokenBudget must be a positive safe integer');
    return { async assemble(messages, signal, options) {
        signal.throwIfAborted();
        if (options?.tokenBudget !== undefined && (!Number.isSafeInteger(options.tokenBudget) || options.tokenBudget < 1)) throw new RangeError('tokenBudget must be a positive safe integer');
        const currentSystem = options?.system ?? (typeof system === 'function' ? await system(messages, signal) : system);
        const result = await composeAgentContext({ messages, system: currentSystem, signal, ...options, tokenBudget: Math.min(tokenBudget, options?.tokenBudget ?? tokenBudget) }, { protectUserMessages: 'all', ...policy });
        signal.throwIfAborted();
        return { system: result.system, messages: result.messages, report: { tokenBudget: result.tokenBudget, usage: result.usage, decisions: result.decisions, systemSections: result.systemSections } };
    } };
}

const filePath = workspaceFilePath;
const includeIgnored = z.boolean().optional().describe('Include ignored, dependency and generated files. Default: false; Git metadata stays excluded.');
const searchPath = z.string().describe('Path inside the workspace. An empty string means the workspace root.');
const schemas: Record<string, z.ZodType<Record<string, unknown>>> = {
    review_changes: z.object({ base: z.string().min(1).max(4096).optional().describe('Commit or ref to compare with the tracked working tree. Default: HEAD. Requires an existing commit.') }).strict(),
    read_output: z.object({ id: z.string().uuid(), offset: z.number().int().nonnegative().optional() }).strict(),
    fs_read: fsReadSchema,
    fs_write: fsWriteSchema,
    fs_list: z.object({ path: searchPath, recursive: z.boolean().optional() }).strict(),
    fs_patch: z.object({ path: filePath, patches: z.array(z.object({ search: z.string().min(1), replace: z.string() }).strict()).min(1).max(100) }).strict(),
    search_grep: z.object({ include_ignored: includeIgnored, pattern: z.string().min(1).max(4096).describe('Regex by default; set literal: true to search for exact text.'), path: searchPath.optional().describe('Search path. Omit or use an empty string for the workspace root.'), include: z.string().optional(), case_sensitive: z.boolean().optional(), literal: z.boolean().optional().describe('Treat pattern as literal text instead of regex. Default: false.'), context_lines: z.number().int().min(0).max(10).optional(), max_results: z.number().int().min(1).max(100).optional(), output: z.enum(['content', 'files_only', 'count']).optional() }).strict(),
    search_find: z.object({ include_ignored: includeIgnored, pattern: z.string().min(1).describe('Glob pattern, for example **/*.ts.'), path: searchPath.optional().describe('Search path. Omit or use an empty string for the workspace root.') }).strict(),
    shell_run: z.object({ command: z.string().min(1), cwd: searchPath.optional(), timeout_ms: z.number().int().min(1).max(120000).optional(), env: z.record(z.string(), z.string()).optional() }).strict(),
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

function runShell(root: string, outputStore: FileToolOutputStore, args: Record<string, unknown>, options?: ToolCallOptions): Promise<ToolCallResult> {
    if (options?.signal?.aborted) return Promise.resolve({ ok: false, content: 'Cancelled before execution', errorKind: 'cancelled' });
    const cwd = confined(root, args.cwd as string ?? '.');
    return new Promise(resolve => {
        const child = spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
            process.platform === 'win32' ? ['/d', '/s', '/c', args.command as string] : ['-c', args.command as string],
            { cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...args.env as Record<string, string> } });
        const outputCapture = new ToolOutputCapture();
        let stopped: 'cancelled' | 'timeout' | undefined;
        let finished = false;
        const capture = (data: Buffer) => outputCapture.append(data);
        const stop = (reason: 'cancelled' | 'timeout') => {
            stopped ??= reason;
            try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); }
        };
        const abort = () => stop('cancelled');
        const timer = setTimeout(() => stop('timeout'), args.timeout_ms as number ?? 30000);
        const finish = async (code: number | null, error?: Error) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            options?.signal?.removeEventListener('abort', abort);
            const { content: output, ...captureMetadata } = await outputCapture.finish(outputStore);
            resolve({ ok: !stopped && !error && code === 0,
                content: `${output}${output ? '\n' : ''}${stopped ?? error?.message ?? `Exit code: ${code}`}`,
                ...((stopped || error || code !== 0) ? { errorKind: stopped ?? 'runtime' as const } : {}),
                data: { exitCode: code, ...captureMetadata } });
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
const codingEffects = {
    fs_read: 'read', fs_list: 'read', search_grep: 'read', search_find: 'read', read_output: 'read',
    // Git may invoke repository-configured filters or filesystem-monitor hooks.
    fs_write: 'write', fs_patch: 'write', shell_run: 'write', review_changes: 'write',
} as const;

export function codingToolEffect(name: string): 'read' | 'write' | undefined {
    return Object.hasOwn(codingEffects, name) ? codingEffects[name as keyof typeof codingEffects] : undefined;
}

export function codingToolRuntime(workingRoot: string, options: {
    outputDirectory?: string;
    /** Exclude editing and command execution from both discovery and dispatch. */
    readOnly?: boolean;
    /** Complete-line file page ceiling in bytes; defaults to 16000. Validated by FsToolRuntime. */
    textPageBytes?: number;
} = {}): IValidatedToolRuntime {
    const root = realpathSync(workingRoot);
    const outputStore = new FileToolOutputStore(options.outputDirectory ?? path.join(tmpdir(), 'agentic-output', createHash('sha256').update(root).digest('hex')));
    const fs = new FsToolRuntime(root, { textPageBytes: options.textPageBytes ?? 16000 });
    const search = new SearchToolRuntime(root, { maxOutputBytes: 4000 });
    const shell = new ShellToolRuntime(root);
    const definitions = structuredClone([...fs.tools(), ...search.tools(), ...shell.tools(), {
        name: 'read_output', description: 'Read exact saved tool text by output ID. Offset and nextOffset use UTF-16 code units; returns up to 4000 units. Continue until eof. Saved output may be incomplete if capture reached its limit.',
        parameters: { type: 'object' as const, properties: { id: { type: 'string' as const }, offset: { type: 'integer' as const, minimum: 0 } }, required: ['id'], additionalProperties: false },
    }, {
        name: 'review_changes', description: 'Review actual Git changes within this workspace: tracked diff statistics, whitespace-ignored statistics (not semantic equivalence), untracked paths, and a read_output reference to the exact tracked patch. Includes staged and unstaged changes against base (default HEAD); untracked contents and ignored files are excluded. Requires Git, an existing commit and command-execution permission: Git may invoke repository-configured helpers. Fails if capture exceeds 8 MiB. Use source, tests and task requirements to assess fulfillment.',
        parameters: { type: 'object' as const, properties: {} },
    }]).filter(tool => codingToolEffect(tool.name) !== undefined && (!options.readOnly || codingToolEffect(tool.name) === 'read'))
        .map(tool => ({ ...tool, parameters: { ...z.toJSONSchema(schemas[tool.name], { target: 'draft-7' }), type: 'object' } as ToolDefinition['parameters'] }));
    const shellDefinition = definitions.find(tool => tool.name === 'shell_run');
    if (shellDefinition) shellDefinition.description += ' Large output is saved with a read_output reference; capture is limited to 8 MiB and reports incompleteness.';
    const enabled = new Set(definitions.map(tool => tool.name));
    const runtime: IValidatedToolRuntime = {
        tools: () => structuredClone(definitions),
        validate(name, args) {
            const schema = schemas[name];
            if (!schema || !enabled.has(name)) return { ok: false, result: { ok: false, content: `Unknown tool: ${name}`, errorKind: 'validation' } };
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
                if (name === 'read_output') return { ok: true, content: JSON.stringify(await outputStore.read(checked.args.id as string, checked.args.offset as number ?? 0, options?.signal)) };
                if (name === 'review_changes') return await reviewChanges(root, outputStore, checked.args.base as string ?? 'HEAD', options?.signal);
                if (name === 'shell_run') return await runShell(root, outputStore, checked.args, options);
                return await (name.startsWith('fs_') ? fs : search).call(name, checked.args, options);
            } catch (error) { return { ok: false, content: String(error), errorKind: 'runtime' }; }
        },
        trustTierFor: () => 'standard',
        effectFor: name => enabled.has(name) ? codingToolEffect(name) : undefined,
    };
    return runtime;
}

export function defaultCodingPolicy(): IToolPolicy {
    return { async evaluate(context) {
        return codingToolEffect(context.name) === 'read' || ['memory_search', 'memory_read', 'read_tool_result'].includes(context.name) ? { kind: 'allow' }
            : { kind: 'confirm', reason: `Approve ${context.name} with these exact arguments` };
    } };
}
