/**
 * Shell tool — execute a command in a subprocess.
 *
 * Bounded output, configurable timeout, working directory relative to root.
 * stdout and stderr are captured and returned together so the LLM sees the
 * full picture. Exit code is included so the LLM can distinguish success from
 * failure without interpreting output heuristics.
 */

import { spawn }  from 'node:child_process'
import * as fs     from 'node:fs'
import * as path   from 'node:path'
import type { ToolDefinition } from '../contracts/llm.js'
import type { IToolRuntime, ToolCallResult } from '../contracts/tool-runtime.js'

// ── Limits ────────────────────────────────────────────────────────────────────

const MAX_OUTPUT_BYTES = 64 * 1024    // 64 KB
const DEFAULT_TIMEOUT  = 30_000       // 30 s
const MAX_TIMEOUT      = 120_000      // 2 min hard cap

function withinRoot(root: string, abs: string): boolean {
    const rel = path.relative(path.resolve(root), abs)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function resolveCwd(root: string, cwdArg: string): string {
    const target = cwdArg.trim() || '.'
    return path.resolve(root, target)
}

function detectShell(): string {
    const candidates = [process.env['SHELL'], '/bin/sh', '/usr/bin/sh'].filter(Boolean) as string[]
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate
    }
    return 'sh'
}

// ── Definitions ───────────────────────────────────────────────────────────────

const DEFINITIONS: ToolDefinition[] = [
    {
        name: 'shell_run',
        description: [
            'Run a shell command. Returns exit code, stdout, and stderr.',
            'Commands run in a subprocess — no persistent state between calls.',
            `Default timeout: ${DEFAULT_TIMEOUT / 1000}s, max: ${MAX_TIMEOUT / 1000}s. Background processes (&) block until timeout.`,
            'Use for: compiling, running tests, git operations, file processing.',
        ].join(' '),
        parameters: {
            type: 'object',
            required: ['command'],
            properties: {
                command:    { type: 'string', description: 'The shell command to run.' },
                cwd:        { type: 'string', description: 'Working directory (relative to working root). Default: root.' },
                timeout_ms: { type: 'number', description: `Timeout in milliseconds. Default: ${DEFAULT_TIMEOUT}. Max: ${MAX_TIMEOUT}.` },
                env:        { type: 'object', description: 'Additional environment variables.' },
            },
        },
    },
]

// ── Handler ───────────────────────────────────────────────────────────────────

function runCommand(
    command: string,
    cwd: string,
    timeoutMs: number,
    env: Record<string, string>,
): Promise<{ exitCode: number; output: string; truncated: boolean }> {
    return new Promise(resolve => {
        const chunks: Buffer[] = []
        let totalBytes = 0
        let truncated  = false
        const shell = detectShell()

        const proc = spawn(shell, ['-c', command], {
            cwd,
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
        })

        function onData(chunk: Buffer) {
            if (truncated) return
            totalBytes += chunk.byteLength
            if (totalBytes > MAX_OUTPUT_BYTES) {
                truncated = true
                chunks.push(chunk.slice(0, chunk.byteLength - (totalBytes - MAX_OUTPUT_BYTES)))
                return
            }
            chunks.push(chunk)
        }

        proc.stdout.on('data', onData)
        proc.stderr.on('data', onData)

        const timer = setTimeout(() => {
            try { process.kill(-proc.pid!, 'SIGKILL') } catch {}
        }, timeoutMs)

        proc.on('close', (code) => {
            clearTimeout(timer)
            const output = Buffer.concat(chunks).toString('utf8')
            resolve({ exitCode: code ?? -1, output, truncated })
        })

        proc.on('error', (err) => {
            clearTimeout(timer)
            resolve({ exitCode: -1, output: err.message, truncated: false })
        })
    })
}

// ── Runtime ───────────────────────────────────────────────────────────────────

export class ShellToolRuntime implements IToolRuntime {
    constructor(private readonly root: string) {}

    tools(): ToolDefinition[] {
        return DEFINITIONS
    }

    async call(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
        if (name !== 'shell_run') return { ok: false, content: `Unknown tool: ${name}` }

        const command   = String(args['command'] ?? '').trim()
        if (!command) return { ok: false, content: 'command is required' }

        const relCwd    = String(args['cwd'] ?? '')
        const cwd       = resolveCwd(this.root, relCwd)
        if (!withinRoot(this.root, cwd)) {
            return { ok: false, content: `cwd escapes working root: ${relCwd}` }
        }
        if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
            return { ok: false, content: `Working directory not found: ${relCwd || '.'}` }
        }
        const timeoutMs = Math.min(Number(args['timeout_ms'] ?? DEFAULT_TIMEOUT), MAX_TIMEOUT)
        const env       = (args['env'] ?? {}) as Record<string, string>

        const { exitCode, output, truncated } = await runCommand(command, cwd, timeoutMs, env)

        const content = [
            `Exit code: ${exitCode}`,
            truncated ? `Output (truncated at ${MAX_OUTPUT_BYTES} bytes):` : 'Output:',
            output || '(empty)',
        ].join('\n')

        return {
            ok:      exitCode === 0,
            content,
            data:    { exitCode, truncated },
        }
    }
}
