/**
 * Search tools — grep and find within a working root.
 *
 * Uses Node's built-in fs for portability (no ripgrep/find dependency).
 * Results are bounded to prevent flooding the context window.
 */

import * as fs   from 'node:fs'
import * as path from 'node:path'
import type { ToolDefinition } from '../contracts/llm.js'
import type { IToolRuntime, ToolCallResult } from '../contracts/tool-runtime.js'

// ── Limits ────────────────────────────────────────────────────────────────────

const MAX_MATCHES    = 100
const MAX_LINE_LEN   = 500
const MAX_FILE_BYTES = 1024 * 1024   // skip files > 1 MB

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(content: string, data?: unknown): ToolCallResult {
    return { ok: true, content, data }
}

function fail(content: string): ToolCallResult {
    return { ok: false, content }
}

function withinRoot(root: string, abs: string): boolean {
    const rel = path.relative(path.resolve(root), abs)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function matchesGlob(filename: string, pattern: string): boolean {
    // Simple glob: * matches any chars except /, ** matches anything
    const regex = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')   // escape regex specials except * and ?
        .replace(/\*\*/g, '§§')                   // placeholder for **
        .replace(/\*/g, '[^/]*')                  // * matches within segment
        .replace(/\?/g, '[^/]')                   // ? matches one char
        .replace(/§§/g, '.*')                     // ** matches across segments
    return new RegExp(`^${regex}$`).test(filename)
}

function* walkFiles(dir: string, root: string, include?: string): Generator<string> {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }

    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const abs = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            yield* walkFiles(abs, root, include)
        } else if (entry.isFile()) {
            if (include) {
                const rel = path.relative(root, abs)
                if (!matchesGlob(rel, include) && !matchesGlob(entry.name, include)) continue
            }
            yield abs
        }
    }
}

// ── Definitions ───────────────────────────────────────────────────────────────

const DEFINITIONS: ToolDefinition[] = [
    {
        name:        'search_grep',
        description: 'Search for a pattern (regex or literal) across files in the working root. Returns matching lines with file and line number.',
        parameters: {
            type: 'object',
            required: ['pattern'],
            properties: {
                pattern:       { type: 'string', description: 'Regex or literal string to search for.' },
                path:          { type: 'string', description: 'Subdirectory to search in (relative to root). Default: root.' },
                include:       { type: 'string', description: 'Glob pattern to filter files (e.g. "*.ts", "**/*.md"). Default: all files.' },
                case_sensitive: { type: 'boolean', description: 'Case-sensitive match. Default: false.' },
                literal:       { type: 'boolean', description: 'Treat pattern as literal string, not regex. Default: false.' },
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
                pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.md", "src/*.ts").' },
                path:    { type: 'string', description: 'Subdirectory to search in. Default: root.' },
            },
        },
    },
]

// ── Handlers ──────────────────────────────────────────────────────────────────

function handleGrep(root: string, args: Record<string, unknown>): ToolCallResult {
    const patternStr    = String(args['pattern'] ?? '').trim()
    if (!patternStr) return fail('pattern is required')

    const subdir        = String(args['path'] ?? '')
    const include       = args['include'] ? String(args['include']) : undefined
    const caseSensitive = Boolean(args['case_sensitive'] ?? false)
    const literal       = Boolean(args['literal'] ?? false)

    const searchRoot = subdir ? path.resolve(root, subdir) : root
    if (!withinRoot(root, searchRoot)) return fail(`Path escapes working root: ${subdir}`)
    if (!fs.existsSync(searchRoot)) return fail(`Path not found: ${subdir || '.'}`)

    let regex: RegExp
    try {
        const source = literal ? patternStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : patternStr
        regex = new RegExp(source, caseSensitive ? '' : 'i')
    } catch (e) {
        return fail(`Invalid pattern: ${e instanceof Error ? e.message : String(e)}`)
    }

    const matches: string[] = []
    let truncated = false

    for (const abs of walkFiles(searchRoot, root, include)) {
        if (truncated) break
        let stat: fs.Stats
        try { stat = fs.statSync(abs) } catch { continue }
        if (stat.size > MAX_FILE_BYTES) continue

        let content: string
        try { content = fs.readFileSync(abs, 'utf8') } catch { continue }

        const rel   = path.relative(root, abs)
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
                const line = lines[i].length > MAX_LINE_LEN
                    ? lines[i].slice(0, MAX_LINE_LEN) + '…'
                    : lines[i]
                matches.push(`${rel}:${i + 1}: ${line}`)
                if (matches.length >= MAX_MATCHES) { truncated = true; break }
            }
        }
    }

    if (matches.length === 0) return ok('No matches found.')

    const content = matches.join('\n') + (truncated ? `\n(truncated at ${MAX_MATCHES} matches)` : '')
    return ok(content, { count: matches.length, truncated })
}

function handleFind(root: string, args: Record<string, unknown>): ToolCallResult {
    const pattern = String(args['pattern'] ?? '').trim()
    if (!pattern) return fail('pattern is required')

    const subdir     = String(args['path'] ?? '')
    const searchRoot = subdir ? path.resolve(root, subdir) : root
    if (!withinRoot(root, searchRoot)) return fail(`Path escapes working root: ${subdir}`)
    if (!fs.existsSync(searchRoot)) return fail(`Path not found: ${subdir || '.'}`)

    const results: string[] = []
    let truncated = false

    for (const abs of walkFiles(searchRoot, root)) {
        const rel = path.relative(root, abs)
        if (matchesGlob(rel, pattern) || matchesGlob(path.basename(abs), pattern)) {
            results.push(rel)
            if (results.length >= MAX_MATCHES) { truncated = true; break }
        }
    }

    if (results.length === 0) return ok('No files found.')

    const content = results.join('\n') + (truncated ? `\n(truncated at ${MAX_MATCHES} results)` : '')
    return ok(content, { count: results.length, truncated })
}

// ── Runtime ───────────────────────────────────────────────────────────────────

export class SearchToolRuntime implements IToolRuntime {
    constructor(private readonly root: string) {}

    tools(): ToolDefinition[] {
        return DEFINITIONS
    }

    async call(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
        switch (name) {
            case 'search_grep': return handleGrep(this.root, args)
            case 'search_find': return handleFind(this.root, args)
            default:            return { ok: false, content: `Unknown tool: ${name}` }
        }
    }
}
