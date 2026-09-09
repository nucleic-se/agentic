/** Bounded workspace search. Regex and traversal run off-thread so cancellation can stop them. */
import { Worker } from 'node:worker_threads'
import type { ToolDefinition } from '../contracts/llm.js'
import type { IToolRuntime, ToolCallResult, ToolCallOptions } from '../contracts/tool-runtime.js'

// ── Definitions ───────────────────────────────────────────────────────────────

const DEFINITIONS: ToolDefinition[] = [
    {
        name:        'search_grep',
        description: 'Search for a pattern (regex or literal) across files. Supports context lines, result limits, and output modes (content/files_only/count).',
        parameters: {
            type: 'object',
            required: ['pattern'],
            properties: {
                include_ignored: { type: 'boolean', description: 'Include ignored/dependency/generated files. Default: false. Git metadata is always excluded.' },
                pattern:        { type: 'string', description: 'Regex or literal string to search for.' },
                path:           { type: 'string', description: 'File or directory to search (relative to root). Default: root.' },
                include:        { type: 'string', description: 'Glob pattern to filter files (e.g. "*.ts", "**/*.md"). Default: all files.' },
                case_sensitive: { type: 'boolean', description: 'Case-sensitive match. Default: false.' },
                literal:        { type: 'boolean', description: 'Treat pattern as literal string, not regex. Default: false.' },
                context_lines:  { type: 'integer', description: 'Number of lines to show before and after each match. Default: 0.' },
                max_results:    { type: 'integer', description: 'Maximum matches to return. Default: 100.' },
                output:         { type: 'string', enum: ['content', 'files_only', 'count'], description: 'Output mode. "content": matching lines (default). "files_only": just file paths. "count": match count per file.' },
            },
        },
    },
    {
        name:        'search_find',
        description: 'Find files matching a glob pattern within the working root.',
        parameters: {
            type: 'object',
            required: ['pattern'],
            properties: {
                include_ignored: { type: 'boolean', description: 'Include ignored/dependency/generated files. Default: false. Git metadata is always excluded.' },
                pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.md", "src/*.ts").' },
                path:    { type: 'string', description: 'File or directory to search. Default: root.' },
            },
        },
    },
]

/** Each call owns one worker; cancellation and the finite timeout terminate it. */
export class SearchToolRuntime implements IToolRuntime {
    private readonly maxOutputBytes: number

    constructor(private readonly root: string, options: { maxOutputBytes?: number } = {}) {
        this.maxOutputBytes = options.maxOutputBytes ?? 256 * 1024
        if (!Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes < 512 || this.maxOutputBytes > 256 * 1024)
            throw new RangeError('maxOutputBytes must be an integer between 512 and 262144')
    }

    tools(): ToolDefinition[] {
        return structuredClone(DEFINITIONS).map(tool => ({ ...tool,
            description: `${tool.description} Respects .gitignore and excludes dependency/build/cache directories and common credential files by default; include_ignored overrides this. Hidden configuration is searchable; .git is always excluded. Output is bounded to ${this.maxOutputBytes} bytes. Truncated results require a narrower pattern/path. Matching lines come first; context uses remaining space. Omitted context and clipped long lines have notices; use fs_read for source lines. Files over 1 MiB are skipped.`,
        }))
    }

    async call(name: string, args: Record<string, unknown>, options?: ToolCallOptions): Promise<ToolCallResult> {
        if (!['search_grep', 'search_find'].includes(name)) return { ok: false, content: `Unknown tool: ${name}` }
        if (options?.signal?.aborted) return { ok: false, content: 'Search cancelled', errorKind: 'cancelled' }
        return new Promise(resolve => {
            let worker: Worker
            try {
                worker = new Worker(new URL('./search-worker.js', import.meta.url), { workerData: { root: this.root, name, args, maxOutputBytes: this.maxOutputBytes },
                    execArgv: process.execArgv.filter((arg, index, all) => !arg.startsWith('--input-type') && all[index - 1] !== '--input-type') })
            } catch (error) {
                resolve({ ok: false, content: `Search failed: ${String(error)}`, errorKind: 'runtime' }); return
            }
            let settled = false
            const finish = (result: ToolCallResult) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                options?.signal?.removeEventListener('abort', abort)
                // Await termination: no traversal or regex remains after the result is returned.
                void worker.terminate().then(() => resolve(result), () => resolve(result))
            }
            const abort = () => finish({ ok: false, content: 'Search cancelled', errorKind: 'cancelled' })
            const timer = setTimeout(() => finish({ ok: false, content: 'Search exceeded 30 second deadline', errorKind: 'timeout' }), 30_000)
            worker.on('message', (message: ToolCallResult | { phase: 'searching' }) => {
                if (settled) return
                if ('phase' in message) {
                    try { options?.onUpdate?.(message) } catch { /* Observers cannot stop search. */ }
                } else finish(message)
            })
            worker.once('error', error => finish({ ok: false, content: `Search failed: ${String(error)}`, errorKind: 'runtime' }))
            worker.once('exit', code => finish({ ok: false, content: `Search worker exited without a result (${code})`, errorKind: 'runtime' }))
            options?.signal?.addEventListener('abort', abort, { once: true })
            if (options?.signal?.aborted) abort()
        })
    }
}
