import { ShellProcesses } from './shell-process.js';
import { fsReadSchema, fsWriteSchema, workspaceFilePath } from '../../tools/fs-schema.js';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { FileToolOutputStore } from './output.js';
import { reviewChanges } from './change-review.js';
import { lstatSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { ToolDefinition } from '../../contracts/llm.js';
import type { IToolPolicy } from '../../contracts/IToolPolicy.js';
import type { IValidatedToolRuntime, ToolCallOptions, ToolCallResult } from '../../contracts/tool-runtime.js';
import { FsToolRuntime } from '../../tools/fs.js';
import { SearchToolRuntime } from '../../tools/search.js';
import { ShellToolRuntime } from '../../tools/shell.js';

const filePath = workspaceFilePath;
const includeIgnored = z.boolean().optional().describe('Include ignored, dependency and generated files. Default: false; Git metadata stays excluded.');
const searchPath = z.string().describe('Path inside the workspace. An empty string means the workspace root.');
const schemas: Record<string, z.ZodType<Record<string, unknown>>> = {
    review_changes: z.object({
        base: z.string().min(1).max(4096).optional().describe('Commit or ref to compare with the tracked working tree. Default: HEAD. Requires an existing commit.'),
    }).strict(),
    read_output: z.object({
        id: z.string().uuid(),
        offset: z.number().int().nonnegative().optional(),
    }).strict(),
    fs_read: fsReadSchema,
    fs_write: fsWriteSchema,
    fs_list: z.object({
        path: searchPath,
        recursive: z.boolean().optional(),
    }).strict(),
    fs_patch: z.object({
        path: filePath,
        patches: z.array(z.object({
            search: z.string().min(1),
            replace: z.string(),
        }).strict()).min(1).max(100),
    }).strict(),
    search_grep: z.object({
        include_ignored: includeIgnored,
        pattern: z.string().min(1).max(4096).describe('Regex by default; set literal: true to search for exact text.'),
        path: searchPath.optional().describe('Search path. Omit or use an empty string for the workspace root.'),
        include: z.string().optional(),
        case_sensitive: z.boolean().optional(),
        literal: z.boolean().optional().describe('Treat pattern as literal text instead of regex. Default: false.'),
        context_lines: z.number().int().min(0).max(10).optional(),
        max_results: z.number().int().min(1).max(100).optional(),
        output: z.enum(['content', 'files_only', 'count']).optional(),
    }).strict(),
    search_find: z.object({
        include_ignored: includeIgnored,
        pattern: z.string().min(1).describe('Glob pattern, for example **/*.ts.'),
        path: searchPath.optional().describe('Search path. Omit or use an empty string for the workspace root.'),
    }).strict(),
    shell_list: z.object({}).strict(),
    shell_wait: z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    shell_poll: z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), offset: z.number().int().nonnegative().optional(), yield_after_ms: z.number().int().min(0).max(120000).optional() }).strict(),
    shell_cancel: z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    shell_run: z.object({
        command: z.string().min(1),
        cwd: searchPath.optional(),
        yield_after_ms: z.number().int().min(0).max(120000).optional().describe("Wait for output, then return a running handle without stopping execution."),
        timeout_ms: z.number().int().min(1).max(120000).optional().describe("Deprecated alias for yield_after_ms; does not kill the command."),
        execution_timeout_ms: z.number().int().min(1).max(2147483647).optional().describe("Explicit execution deadline that kills the process group; omitted by default."),
        env: z.record(z.string(), z.string()).optional(),
    }).strict(),
};

function confined(root: string, target: string): string {
    const absolute = path.resolve(root, target);
    const relative = path.relative(root, absolute);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Path escapes working root');
    let current = root;
    for (const part of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        try {
            if (lstatSync(current).isSymbolicLink()) throw new Error('Symbolic links are not allowed');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }
    return absolute;
}

/** Local trusted-code tools. Root checks do not sandbox arbitrary shell commands. */
const codingEffects = {
    fs_read: 'read', fs_list: 'read', search_grep: 'read', search_find: 'read', read_output: 'read', shell_poll: 'read', shell_wait: 'read', shell_list: 'read',
    // Git may invoke repository-configured filters or filesystem-monitor hooks.
    fs_write: 'write', fs_patch: 'write', shell_run: 'write', shell_cancel: 'write', review_changes: 'write',
} as const;

export function codingToolEffect(name: string): 'read' | 'write' | undefined {
    return Object.hasOwn(codingEffects, name) ? codingEffects[name as keyof typeof codingEffects] : undefined;
}

export function codingToolRuntime(workingRoot: string, options: {
    outputDirectory?: string;
    /** Private durable command receipts; defaults alongside saved output. */
    processDirectory?: string;
    /** Host-owned logical scope, stable across transcript handoff. */
    processOwner?: string;
    /** Exclude editing and command execution from both discovery and dispatch. */
    readOnly?: boolean;
    /** Complete-line file page ceiling in bytes; defaults to 16000. Validated by FsToolRuntime. */
    textPageBytes?: number;
} = {}): IValidatedToolRuntime {
    const root = realpathSync(workingRoot);
    const outputDirectory = options.outputDirectory ?? path.join(tmpdir(), 'agentic-output', createHash('sha256').update(root).digest('hex'));
    const outputStore = new FileToolOutputStore(outputDirectory);
    const processes = new ShellProcesses(options.processDirectory ?? path.join(outputDirectory, 'processes'), outputDirectory, options.processOwner);
    const fs = new FsToolRuntime(root, { textPageBytes: options.textPageBytes ?? 16000 });
    const search = new SearchToolRuntime(root, { maxOutputBytes: 4000 });
    const shell = new ShellToolRuntime(root);
    const definitions = structuredClone([...fs.tools(), ...search.tools(), ...shell.tools(), { name: 'shell_list', description: 'List command handles and lifecycle states owned by this scope, including commands retained across a transcript handoff.', parameters: {type: 'object' as const} }, { name: 'shell_poll', description: 'Inspect an existing command by its session-owned process ID; optionally wait for completion. Never starts a command.', parameters: {type: 'object' as const} }, { name: 'shell_wait', description: 'Sleep in the host until an existing command completes, without model calls or an implicit wait deadline. Interruption stops waiting, not the command. Never starts or repeats a command.', parameters: {type: 'object' as const} }, { name: 'shell_cancel', description: 'Explicitly request cancellation of a session-owned command. Prior effects are not rolled back; poll for the terminal receipt.', parameters: {type: 'object' as const} }, {
        name: 'read_output', description: 'Read exact saved tool text by output ID. Offset and nextOffset use UTF-16 code units; returns up to 4000 units. Continue until eof. Saved output may be incomplete if capture reached its limit.',
        parameters: { type: 'object' as const, properties: { id: { type: 'string' as const }, offset: { type: 'integer' as const, minimum: 0 } }, required: ['id'], additionalProperties: false },
    }, {
        name: 'review_changes', description: 'Review actual Git changes within this workspace: tracked diff statistics, whitespace-ignored statistics (not semantic equivalence), untracked paths, and a read_output reference to the exact tracked patch. Includes staged and unstaged changes against base (default HEAD); untracked contents and ignored files are excluded. Requires Git, an existing commit and command-execution permission: Git may invoke repository-configured helpers. Fails if capture exceeds 8 MiB. Use source, tests and task requirements to assess fulfillment.',
        parameters: { type: 'object' as const, properties: {} },
    }]).filter(tool => codingToolEffect(tool.name) !== undefined && (!options.readOnly || codingToolEffect(tool.name) === 'read'))
        .map(tool => ({ ...tool, parameters: { ...z.toJSONSchema(schemas[tool.name], { target: 'draft-7' }), type: 'object' } as ToolDefinition['parameters'] }));
    const shellDefinition = definitions.find(tool => tool.name === 'shell_run');
    if (shellDefinition) shellDefinition.description = 'Start a command with no implicit execution deadline. Wait briefly (yield_after_ms, default 1000), then return a process ID if still running. Use shell_wait to sleep until that ID completes, or shell_poll for an immediate status check. timeout_ms is a deprecated wait alias. Use shell_cancel for explicit cancellation; only execution_timeout_ms imposes a killing deadline.' + ' Large output is saved with a read_output reference; capture is limited to 8 MiB and reports incompleteness.';
    const enabled = new Set(definitions.map(tool => tool.name));
    const runtime: IValidatedToolRuntime = {
        tools: () => structuredClone(definitions),
        validate(name, args) {
            const schema = schemas[name];
            if (!schema || !enabled.has(name)) return { ok: false, result: { ok: false, content: `Unknown tool: ${name}`, errorKind: 'validation' } };
            const parsed = schema.safeParse(args);
            if (!parsed.success) return { ok: false, result: { ok: false, content: parsed.error.message, errorKind: 'validation' } };
            if (name === 'shell_run' && parsed.data.timeout_ms !== undefined && parsed.data.yield_after_ms !== undefined && parsed.data.timeout_ms !== parsed.data.yield_after_ms) return { ok: false, result: { ok: false, content: 'Conflicting timeout_ms and yield_after_ms wait values', errorKind: 'validation' } };
            try {
                for (const key of ['path', 'from', 'to', 'cwd']) {
                    if (typeof parsed.data[key] === 'string') confined(root, parsed.data[key] as string);
                }
            } catch (error) {
                return { ok: false, result: { ok: false, content: String(error), errorKind: 'validation' } };
            }
            return { ok: true, args: parsed.data };
        },
        async call(name, args, options) {
            try {
                const checked = runtime.validate(name, args);
                if (!checked.ok) return checked.result;
                if (options?.authorizedArgs && !isDeepStrictEqual(checked.args, options.authorizedArgs)) return { ok: false, content: 'Arguments differ from authorization', errorKind: 'policy' };
                if (options?.signal?.aborted && !['shell_run', 'shell_poll', 'shell_wait'].includes(name)) return { ok: false, content: 'Cancelled', errorKind: 'cancelled' };
                if (name === 'read_output') {
                    return {
                        ok: true,
                        content: JSON.stringify(await outputStore.read(checked.args.id as string, checked.args.offset as number ?? 0, options?.signal)),
                    };
                }
                if (name === 'review_changes') {
                    return await reviewChanges(root, outputStore, checked.args.base as string ?? 'HEAD', options?.signal);
                }
                if (name === 'shell_run') {
                    const { yield_after_ms, timeout_ms, ...execution } = checked.args;
                    return await processes.launch({ ...execution, cwd: confined(root, checked.args.cwd as string ?? '.'), yield_after_ms, timeout_ms }, options);
                }
                if (name === 'shell_list') return await processes.list(options);
                if (name === 'shell_poll') return await processes.poll(checked.args, options);
                if (name === 'shell_wait') return await processes.wait(checked.args, options);
                if (name === 'shell_cancel') return await processes.cancel(checked.args, options);
                return await (name.startsWith('fs_') ? fs : search).call(name, checked.args, options);
            } catch (error) {
                return { ok: false, content: String(error), errorKind: 'runtime' };
            }
        },
        trustTierFor: () => 'standard',
        effectFor: name => enabled.has(name) ? codingToolEffect(name) : undefined,
    };
    return runtime;
}

export function defaultCodingPolicy(): IToolPolicy {
    return { async evaluate(context) {
        return codingToolEffect(context.name) === 'read' || ['memory_search', 'memory_read', 'read_tool_result', 'read_skill'].includes(context.name) ? { kind: 'allow' }
            : { kind: 'confirm', reason: `Approve ${context.name} with these exact arguments` };
    } };
}
