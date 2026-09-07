import { parentPort, workerData } from 'node:worker_threads'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ToolCallResult } from '../contracts/tool-runtime.js'

// ── Limits ────────────────────────────────────────────────────────────────────

const MAX_MATCHES    = 100
const MAX_LINE_LEN   = 500
const MAX_FILE_BYTES = 1024 * 1024   // skip files > 1 MB
const OUTPUT_NOTICE = '\n[truncated; narrow pattern/path or reduce context_lines]'

/** Reserve space for notices and count summaries; never split a result entry. */
class SearchOutput {
    readonly entries: string[] = []
    private bytes = 0
    constructor(readonly limit: number) {}
    fits(entry: string): boolean { return Buffer.byteLength(entry) <= this.limit - 256 }
    add(entry: string): boolean {
        const size = Buffer.byteLength(entry) + (this.entries.length ? 1 : 0)
        if (this.bytes + size > this.limit - 256) return false
        this.entries.push(entry)
        this.bytes += size
        return true
    }
    text(truncated: boolean): string { return this.entries.join('\n') + (truncated ? OUTPUT_NOTICE : '') }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(content: string, data?: unknown): ToolCallResult {
    return { ok: true, content, data }
}

function fail(content: string): ToolCallResult {
    return { ok: false, content }
}

function withinRoot(root: string, abs: string): boolean {
    try {
        const rel = path.relative(fs.realpathSync(root), fs.realpathSync(abs))
        return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
    } catch { return false }
}

function matchesGlob(filename: string, pattern: string): boolean {
    // A globstar directory may match zero directories, including files at the root.
    const segments = pattern.split('/')
    const regex = segments.map((segment, index) => {
        const last = index === segments.length - 1
        if (segment === '**') return last ? '.*' : '(?:[^/]+/)*'
        const part = segment.replace(/[.*+?^${}()|[\]\\]/g,
            char => char === '*' ? '[^/]*' : char === '?' ? '[^/]' : `\\${char}`)
        return part + (last ? '' : '/')
    }).join('')
    return new RegExp(`^${regex}$`).test(filename)
}

function* walkFiles(dir: string, root: string, include?: string): Generator<string> {
    // Explicit file paths are as useful as directory roots for focused inspection.
    if (fs.statSync(dir).isFile()) {
        if (!include || matchesGlob(path.relative(root, dir), include) || matchesGlob(path.basename(dir), include)) yield dir
        return
    }
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

// ── Handlers ──────────────────────────────────────────────────────────────────

function handleGrep(root: string, args: Record<string, unknown>, maxOutputBytes: number): ToolCallResult {
    const patternStr    = String(args['pattern'] ?? '').trim()
    if (!patternStr) return fail('pattern is required')

    const subdir        = String(args['path'] ?? '')
    const include       = args['include'] ? String(args['include']) : undefined
    const caseSensitive = Boolean(args['case_sensitive'] ?? false)
    const literal       = Boolean(args['literal'] ?? false)
    const contextLines  = Math.min(Math.max(Number(args['context_lines'] ?? 0), 0), 10)
    const maxResults    = Math.min(Math.max(Number(args['max_results'] ?? MAX_MATCHES), 1), MAX_MATCHES)
    const output        = String(args['output'] ?? 'content') as 'content' | 'files_only' | 'count'
    const result = new SearchOutput(maxOutputBytes)

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
        let truncated = false
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
                if (!result.add(output === 'count' ? `${rel}: ${count}` : rel)) {
                    if (!fileCounts.size) return fail('Search entry exceeds output ceiling; use a narrower search path.')
                    truncated = true; break
                }
                fileCounts.set(rel, count)
                if (fileCounts.size >= maxResults) { truncated = true; break }
            }
        }

        if (fileCounts.size === 0) return ok('No matches found.')

        if (output === 'files_only') {
            return ok(result.text(truncated), { fileCount: fileCounts.size, truncated })
        }
        // count mode
        const total = [...fileCounts.values()].reduce((a, b) => a + b, 0)
        return ok(result.text(truncated) + `\n\nTotal: ${total} matches in ${fileCounts.size} returned files`,
            { fileCount: fileCounts.size, totalMatches: total, truncated })
    }

    // content mode — matching lines with optional context
    let truncated = false
    let matchCount = 0
    let contextOmitted = false

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
        const hits = new Set(hitIndices)

        // Build context-aware output
        const emittedLines = new Set<number>()
        for (const hitIdx of hitIndices) {
            if (truncated) break

            const rangeStart = Math.max(0, hitIdx - contextLines)
            const rangeEnd   = Math.min(lines.length - 1, hitIdx + contextLines)

            let block: string[] = []
            let included: number[] = []
            // Separator between non-contiguous ranges
            if (emittedLines.size > 0 && !emittedLines.has(rangeStart - 1)) {
                block.push('--')
            }

            for (let i = rangeStart; i <= rangeEnd; i++) {
                if (emittedLines.has(i)) continue
                included.push(i)

                const line = lines[i].length > MAX_LINE_LEN ? lines[i].slice(0, MAX_LINE_LEN) + '…' : lines[i]
                const marker = hits.has(i) ? ':' : '-'  // : for match, - for context
                block.push(`${rel}:${i + 1}${marker} ${line}`)
            }

            let omitted = false
            if (!result.fits(block.join('\n'))) {
                block = [`${rel}:${hitIdx + 1}: ${lines[hitIdx].slice(0, MAX_LINE_LEN)}${lines[hitIdx].length > MAX_LINE_LEN ? '…' : ''}`, '[context omitted for this match; use fs_read]']
                included = [hitIdx]
                omitted = true
            }
            if (!result.add(block.join('\n'))) {
                if (!matchCount) return fail('Search entry exceeds output ceiling; use a narrower search path.')
                truncated = true; break
            }
            contextOmitted ||= omitted
            for (const index of included) emittedLines.add(index)
            matchCount++
            if (matchCount >= maxResults) { truncated = true; break }
        }
    }

    if (matchCount === 0) return ok('No matches found.')

    return ok(result.text(truncated), { count: matchCount, truncated, contextOmitted })
}

function handleFind(root: string, args: Record<string, unknown>, maxOutputBytes: number): ToolCallResult {
    const pattern = String(args['pattern'] ?? '').trim()
    if (!pattern) return fail('pattern is required')

    const subdir     = String(args['path'] ?? '')
    const searchRoot = subdir ? path.resolve(root, subdir) : root
    if (!withinRoot(root, searchRoot)) return fail(`Path escapes working root: ${subdir}`)
    if (!fs.existsSync(searchRoot)) return fail(`Path not found: ${subdir || '.'}`)

    const results = new SearchOutput(maxOutputBytes)
    let truncated = false

    for (const abs of walkFiles(searchRoot, root)) {
        const rel = path.relative(root, abs)
        if (matchesGlob(rel, pattern) || matchesGlob(path.basename(abs), pattern)) {
            if (!results.add(rel)) {
                if (!results.entries.length) return fail('Search entry exceeds output ceiling; use a narrower search path.')
                truncated = true; break
            }
            if (results.entries.length >= MAX_MATCHES) { truncated = true; break }
        }
    }

    if (results.entries.length === 0) return ok('No files found.')

    return ok(results.text(truncated), { count: results.entries.length, truncated })
}


try {
    const { root, name, args, maxOutputBytes } = workerData
    parentPort!.postMessage({ phase: 'searching' })
    parentPort!.postMessage(name === 'search_grep' ? handleGrep(root, args, maxOutputBytes) : handleFind(root, args, maxOutputBytes))
} catch (error) {
    parentPort!.postMessage({ ok: false, content: `Search failed: ${String(error)}`, errorKind: 'runtime' })
}
