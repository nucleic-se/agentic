import ignore, { type Ignore } from 'ignore'
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

interface SearchScope { base: string; rules: Ignore }
function scope(base: string, defaults = false): SearchScope {
    const rules = ignore().add(defaults ? ['node_modules/', 'dist/', 'build/', 'coverage/', '.cache/', '.data/', '.env', '.env.*', '.npmrc', '.pypirc', '.ssh/', '.aws/'] : [])
    const file = path.join(base, '.gitignore')
    try { if (fs.lstatSync(file).isFile()) rules.add(fs.readFileSync(file, 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    return { base, rules }
}
function searchScopes(root: string, target: string): SearchScope[] {
    const scopes = [scope(root, true)]
    const directory = fs.statSync(target).isDirectory() ? target : path.dirname(target)
    let current = root
    for (const part of path.relative(root, directory).split(path.sep).filter(Boolean)) {
        current = path.join(current, part); scopes.push(scope(current))
    }
    return scopes
}
function excluded(abs: string, directory: boolean, scopes: SearchScope[]): boolean {
    let ignored = false
    for (const scope of scopes) {
        const rel = path.relative(scope.base, abs).split(path.sep).join('/')
        if (!rel || rel.startsWith('../')) continue
        const match = scope.rules.test(rel + (directory ? '/' : ''))
        if (match.ignored) ignored = true
        else if (match.unignored) ignored = false
    }
    return ignored
}
function* walkFiles(dir: string, root: string, include?: string, includeIgnored = false, scopes = includeIgnored ? [] : searchScopes(root, dir)): Generator<string> {
    const directory = fs.statSync(dir).isDirectory()
    if (path.relative(root, dir).split(path.sep).includes('.git') || (!includeIgnored && excluded(dir, directory, scopes))) return
    if (!directory) {
        if (!include || matchesGlob(path.relative(root, dir), include) || matchesGlob(path.basename(dir), include)) yield dir
        return
    }
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
        if (entry.name === '.git') continue
        const abs = path.join(dir, entry.name)
        if (!includeIgnored && excluded(abs, entry.isDirectory(), scopes)) continue
        if (entry.isDirectory()) yield* walkFiles(abs, root, include, includeIgnored, includeIgnored ? [] : [...scopes, scope(abs)])
        else if (entry.isFile()) {
            if (include && !matchesGlob(path.relative(root, abs), include) && !matchesGlob(entry.name, include)) continue
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
    if (!fs.existsSync(searchRoot)) return fail(`Path not found: ${subdir || '.'}`)
    if (!withinRoot(root, searchRoot)) return fail(`Path escapes working root: ${subdir}`)

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
        for (const abs of walkFiles(searchRoot, root, include, args.include_ignored === true)) {
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
                if (fileCounts.size >= maxResults || !result.add(output === 'count' ? `${rel}: ${count}` : rel)) {
                    if (!fileCounts.size) return fail('Search entry exceeds output ceiling; use a narrower search path.')
                    truncated = true; break
                }
                fileCounts.set(rel, count)
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

    // Reserve matching evidence across files before spending anything on context.
    let truncated = false
    let matchCount = 0
    let contextOmitted = false
    let linesClipped = false
    const context = new Map<string, string>()
    const entry = (rel: string, index: number, line: string, marker: string) => {
        let end = Math.min(line.length, MAX_LINE_LEN)
        if (end < line.length && /[\uD800-\uDBFF]/.test(line[end - 1]) && /[\uDC00-\uDFFF]/.test(line[end])) end--
        return `${rel}:${index + 1}${marker} ${line.slice(0, end)}${end < line.length ? '…' : ''}`
    }

    for (const abs of walkFiles(searchRoot, root, include, args.include_ignored === true)) {
        if (truncated) break
        let stat: fs.Stats
        try { stat = fs.statSync(abs) } catch { continue }
        if (stat.size > MAX_FILE_BYTES) continue
        let fileContent: string
        try { fileContent = fs.readFileSync(abs, 'utf8') } catch { continue }

        const rel = path.relative(root, abs)
        const lines = fileContent.split('\n')
        const hits = new Set<number>()
        for (let i = 0; i < lines.length; i++) if (regex.test(lines[i])) hits.add(i)
        for (const hit of hits) {
            if (matchCount >= maxResults || !result.add(entry(rel, hit, lines[hit], ':'))) {
                if (!matchCount) return fail('Search entry exceeds output ceiling; use fs_read for this file.')
                truncated = true
                break
            }
            matchCount++
            linesClipped ||= lines[hit].length > MAX_LINE_LEN
            for (let i = Math.max(0, hit - contextLines); i <= Math.min(lines.length - 1, hit + contextLines); i++) {
                if (!hits.has(i)) context.set(`${rel}:${i}`, lines[i])
            }
        }
    }

    if (matchCount === 0) return ok('No matches found.')
    for (const [key, line] of context) {
        const colon = key.lastIndexOf(':')
        if (result.add(entry(key.slice(0, colon), Number(key.slice(colon + 1)), line, '-'))) {
            linesClipped ||= line.length > MAX_LINE_LEN
        } else contextOmitted = true
    }
    const notices = (contextOmitted ? '\n[context omitted; use fs_read for source lines]' : '')
        + (linesClipped ? '\n[long lines clipped; use fs_read for full source text]' : '')
    return ok(result.text(truncated) + notices, { count: matchCount, truncated, contextOmitted, linesClipped })
}

function handleFind(root: string, args: Record<string, unknown>, maxOutputBytes: number): ToolCallResult {
    const pattern = String(args['pattern'] ?? '').trim()
    if (!pattern) return fail('pattern is required')

    const subdir     = String(args['path'] ?? '')
    const searchRoot = subdir ? path.resolve(root, subdir) : root
    if (!fs.existsSync(searchRoot)) return fail(`Path not found: ${subdir || '.'}`)
    if (!withinRoot(root, searchRoot)) return fail(`Path escapes working root: ${subdir}`)

    const results = new SearchOutput(maxOutputBytes)
    let truncated = false

    for (const abs of walkFiles(searchRoot, root, undefined, args.include_ignored === true)) {
        const rel = path.relative(root, abs)
        if (matchesGlob(rel, pattern) || matchesGlob(path.basename(abs), pattern)) {
            if (results.entries.length >= MAX_MATCHES || !results.add(rel)) {
                if (!results.entries.length) return fail('Search entry exceeds output ceiling; use a narrower search path.')
                truncated = true; break
            }
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
