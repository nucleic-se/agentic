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
        description: 'Search for a pattern (regex or literal) across files. Supports context lines, result limits, and output modes (content/files_only/count).',
        parameters: {
            type: 'object',
            required: ['pattern'],
            properties: {
                pattern:        { type: 'string', description: 'Regex or literal string to search for.' },
                path:           { type: 'string', description: 'Subdirectory to search in (relative to root). Default: root.' },
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
    const contextLines  = Math.min(Math.max(Number(args['context_lines'] ?? 0), 0), 10)
    const maxResults    = Math.min(Math.max(Number(args['max_results'] ?? MAX_MATCHES), 1), MAX_MATCHES)
    const output        = String(args['output'] ?? 'content') as 'content' | 'files_only' | 'count'

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

    // files_only and count modes — just track per-file info
    if (output === 'files_only' || output === 'count') {
        const fileCounts = new Map<string, number>()
        for (const abs of walkFiles(searchRoot, root, include)) {
            let stat: fs.Stats
            try { stat = fs.statSync(abs) } catch { continue }
            if (stat.size > MAX_FILE_BYTES) continue
            let fileContent: string
            try { fileContent = fs.readFileSync(abs, 'utf8') } catch { continue }

            const rel   = path.relative(root, abs)
            const lines = fileContent.split('\n')
            let count = 0
            for (const line of lines) {
                if (regex.test(line)) count++
            }
            if (count > 0) {
                fileCounts.set(rel, count)
                if (output === 'files_only' && fileCounts.size >= maxResults) break
            }
        }

        if (fileCounts.size === 0) return ok('No matches found.')

        if (output === 'files_only') {
            const text = [...fileCounts.keys()].join('\n')
            return ok(text, { fileCount: fileCounts.size })
        }
        // count mode
        const entries = [...fileCounts.entries()].map(([f, c]) => `${f}: ${c}`)
        const total = [...fileCounts.values()].reduce((a, b) => a + b, 0)
        return ok(entries.join('\n') + `\n\nTotal: ${total} matches in ${fileCounts.size} files`, { fileCount: fileCounts.size, totalMatches: total })
    }

    // content mode — matching lines with optional context
    const matches: string[] = []
    let truncated = false
    let matchCount = 0

    for (const abs of walkFiles(searchRoot, root, include)) {
        if (truncated) break
        let stat: fs.Stats
        try { stat = fs.statSync(abs) } catch { continue }
        if (stat.size > MAX_FILE_BYTES) continue

        let fileContent: string
        try { fileContent = fs.readFileSync(abs, 'utf8') } catch { continue }

        const rel   = path.relative(root, abs)
        const lines = fileContent.split('\n')

        // Collect matching line indices for this file
        const hitIndices: number[] = []
        for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) hitIndices.push(i)
        }
        if (hitIndices.length === 0) continue

        // Build context-aware output
        const emittedLines = new Set<number>()
        for (const hitIdx of hitIndices) {
            if (truncated) break

            const rangeStart = Math.max(0, hitIdx - contextLines)
            const rangeEnd   = Math.min(lines.length - 1, hitIdx + contextLines)

            // Separator between non-contiguous ranges
            if (emittedLines.size > 0 && !emittedLines.has(rangeStart - 1)) {
                matches.push('--')
            }

            for (let i = rangeStart; i <= rangeEnd; i++) {
                if (emittedLines.has(i)) continue
                emittedLines.add(i)

                const line = lines[i].length > MAX_LINE_LEN ? lines[i].slice(0, MAX_LINE_LEN) + '…' : lines[i]
                const marker = i === hitIdx ? ':' : '-'  // : for match, - for context
                matches.push(`${rel}:${i + 1}${marker} ${line}`)
            }

            matchCount++
            if (matchCount >= maxResults) { truncated = true; break }
        }
    }

    if (matchCount === 0) return ok('No matches found.')

    const content = matches.join('\n') + (truncated ? `\n(truncated at ${maxResults} matches)` : '')
    return ok(content, { count: matchCount, truncated })
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
