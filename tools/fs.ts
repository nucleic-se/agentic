/**
 * Filesystem tools — read, write, list, delete, move.
 *
 * Paths are resolved relative to a configurable root directory.
 * All writes are restricted to the root; reads default to root-relative
 * but can be made absolute by the caller passing an explicit absoluteRoot.
 *
 * These tools are intended for execute nodes that need to produce
 * file artifacts as part of a solve.
 */

import * as fs   from 'node:fs'
import * as path from 'node:path'
import type { ToolDefinition } from '../contracts/llm.js'
import type { IToolRuntime, ToolCallResult } from '../contracts/tool-runtime.js'

// ── Limits ────────────────────────────────────────────────────────────────────

const MAX_READ_BYTES  = 256 * 1024   // 256 KB
const MAX_WRITE_BYTES = 256 * 1024   // 256 KB
const MAX_LIST_ITEMS  = 200

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(content: string, data?: unknown): ToolCallResult {
    return { ok: true, content, data }
}

function fail(content: string): ToolCallResult {
    return { ok: false, content }
}

function resolve(root: string, filePath: string): string {
    const target = filePath.trim() || '.'
    return path.resolve(root, target)
}

function withinRoot(root: string, abs: string): boolean {
    const rel = path.relative(path.resolve(root), abs)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function normalizeRel(root: string, abs: string): string {
    return path.relative(path.resolve(root), abs).replace(/\\/g, '/')
}

function isProtectedSystemWrite(root: string, abs: string): boolean {
    const rel = normalizeRel(root, abs)
    return /^agents\/[^/]+\/state\.md$/.test(rel)
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const DEFINITIONS: ToolDefinition[] = [
    {
        name:        'fs_read',
        description: 'Read the contents of a file. Supports line-range selection via offset/limit to efficiently read large files without loading the entire content.',
        parameters: {
            type: 'object',
            required: ['path'],
            properties: {
                path:     { type: 'string', description: 'File path (relative to working root or absolute).' },
                encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Encoding. Default: utf8.' },
                offset:   { type: 'integer', description: 'Start reading from this line number (1-based). Default: 1.' },
                limit:    { type: 'integer', description: 'Maximum number of lines to return. Default: all lines.' },
            },
        },
    },
    {
        name:        'fs_write',
        description: 'Write text content to a file. Creates parent directories as needed. Restricted to working root.',
        parameters: {
            type: 'object',
            required: ['path', 'content'],
            properties: {
                path:    { type: 'string', description: 'File path relative to working root.' },
                content: { type: 'string', description: 'Text content to write.' },
                append:  { type: 'boolean', description: 'Append instead of overwrite. Default: false.' },
            },
        },
    },
    {
        name:        'fs_list',
        description: 'List files and directories at a path. Non-recursive by default.',
        parameters: {
            type: 'object',
            required: ['path'],
            properties: {
                path:      { type: 'string', description: 'Directory path.' },
                recursive: { type: 'boolean', description: 'Recurse into subdirectories. Default: false.' },
            },
        },
    },
    {
        name:        'fs_delete',
        description: 'Delete a file. Restricted to working root.',
        parameters: {
            type: 'object',
            required: ['path'],
            properties: {
                path: { type: 'string', description: 'File path relative to working root.' },
            },
        },
    },
    {
        name:        'fs_move',
        description: 'Move or rename a file or directory. Both paths must be within working root.',
        parameters: {
            type: 'object',
            required: ['from', 'to'],
            properties: {
                from: { type: 'string', description: 'Source path relative to working root.' },
                to:   { type: 'string', description: 'Destination path relative to working root.' },
            },
        },
    },
    {
        name:        'fs_patch',
        description: 'Apply exact string replacements to a file. Each operation finds a unique literal string and replaces it. Fails safely if any search string is not found or matches multiple locations. Use this instead of fs_write when editing existing files.',
        parameters: {
            type: 'object',
            required: ['path', 'patches'],
            properties: {
                path:    { type: 'string', description: 'File path relative to working root.' },
                patches: {
                    type: 'array',
                    description: 'Array of {search, replace} pairs. Each search must match exactly once in the file.',
                    items: {
                        type: 'object',
                        required: ['search', 'replace'],
                        properties: {
                            search:  { type: 'string', description: 'Exact string to find (must be unique in the file).' },
                            replace: { type: 'string', description: 'Replacement string.' },
                        },
                    },
                },
            },
        },
    },
]

// ── Handlers ──────────────────────────────────────────────────────────────────

function handleRead(root: string, args: Record<string, unknown>): ToolCallResult {
    const filePath = String(args['path'] ?? '')
    if (!filePath) return fail('path is required')

    const abs = resolve(root, filePath)
    if (!withinRoot(root, abs)) return fail(`Path escapes working root: ${filePath}`)
    if (!fs.existsSync(abs)) return fail(`File not found: ${filePath}`)

    const stat = fs.statSync(abs)
    if (stat.isDirectory()) return fail(`Path is a directory: ${filePath}`)

    const offset = args['offset'] != null ? Number(args['offset']) : undefined
    const limit  = args['limit']  != null ? Number(args['limit'])  : undefined
    const hasLineRange = offset != null || limit != null

    // Allow large files when using line ranges; enforce cap for full reads
    if (!hasLineRange && stat.size > MAX_READ_BYTES) {
        return fail(`File too large: ${stat.size} bytes (max ${MAX_READ_BYTES}). Use offset/limit to read a line range.`)
    }

    try {
        const encoding = String(args['encoding'] ?? 'utf8') as BufferEncoding
        const raw = fs.readFileSync(abs, encoding)

        if (!hasLineRange) {
            return ok(raw, { path: abs, bytes: stat.size })
        }

        // Line-range mode: return numbered lines
        const allLines   = raw.split('\n')
        const totalLines = allLines.length
        const startLine  = Math.max(1, offset ?? 1)
        const endLine    = limit != null ? Math.min(startLine + limit - 1, totalLines) : totalLines

        const selected = allLines.slice(startLine - 1, endLine)
        const numbered = selected.map((line, i) => `${startLine + i}: ${line}`)
        const content  = numbered.join('\n')
        const meta     = { path: abs, bytes: stat.size, totalLines, startLine, endLine, linesReturned: selected.length }

        return ok(content, meta)
    } catch (e) {
        return fail(`Read failed: ${e instanceof Error ? e.message : String(e)}`)
    }
}

function handleWrite(root: string, args: Record<string, unknown>): ToolCallResult {
    const filePath = String(args['path'] ?? '')
    const content  = String(args['content'] ?? '')
    const append   = Boolean(args['append'] ?? false)
    if (!filePath) return fail('path is required')

    const abs = resolve(root, filePath)
    if (!withinRoot(root, abs)) return fail(`Path escapes working root: ${filePath}`)
    if (isProtectedSystemWrite(root, abs)) {
        return fail(`Direct writes to ${filePath} are protected. Use skill_run(update-agent-state) instead.`)
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
        return fail(`Content too large (max ${MAX_WRITE_BYTES} bytes)`)
    }

    try {
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, content, { flag: append ? 'a' : 'w', encoding: 'utf8' })
        const bytes = fs.statSync(abs).size
        return ok(`${append ? 'Appended' : 'Written'}: ${filePath} (${bytes} bytes)`, { path: abs, bytes })
    } catch (e) {
        return fail(`Write failed: ${e instanceof Error ? e.message : String(e)}`)
    }
}

function handleList(root: string, args: Record<string, unknown>): ToolCallResult {
    const dirPath   = String(args['path'] ?? '.')
    const recursive = Boolean(args['recursive'] ?? false)

    const abs = resolve(root, dirPath)
    if (!withinRoot(root, abs)) return fail(`Path escapes working root: ${dirPath}`)
    if (!fs.existsSync(abs)) return fail(`Directory not found: ${dirPath}`)
    if (!fs.statSync(abs).isDirectory()) return fail(`Not a directory: ${dirPath}`)

    try {
        const entries: string[] = []
        function collect(dir: string, prefix: string) {
            if (entries.length >= MAX_LIST_ITEMS) return
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entries.length >= MAX_LIST_ITEMS) break
                const rel = prefix ? `${prefix}/${entry.name}` : entry.name
                entries.push(entry.isDirectory() ? `${rel}/` : rel)
                if (recursive && entry.isDirectory()) collect(path.join(dir, entry.name), rel)
            }
        }
        collect(abs, '')
        const truncated = entries.length >= MAX_LIST_ITEMS
        const text = entries.join('\n') + (truncated ? `\n(truncated at ${MAX_LIST_ITEMS})` : '')
        return ok(text, { path: abs, count: entries.length, truncated })
    } catch (e) {
        return fail(`List failed: ${e instanceof Error ? e.message : String(e)}`)
    }
}

function handleDelete(root: string, args: Record<string, unknown>): ToolCallResult {
    const filePath = String(args['path'] ?? '')
    if (!filePath) return fail('path is required')

    const abs = resolve(root, filePath)
    if (!withinRoot(root, abs)) return fail(`Path escapes working root: ${filePath}`)
    if (isProtectedSystemWrite(root, abs)) {
        return fail(`Direct deletion of ${filePath} is protected.`)
    }
    if (!fs.existsSync(abs)) return fail(`File not found: ${filePath}`)

    try {
        fs.rmSync(abs, { recursive: false })
        return ok(`Deleted: ${filePath}`)
    } catch (e) {
        return fail(`Delete failed: ${e instanceof Error ? e.message : String(e)}`)
    }
}

function handleMove(root: string, args: Record<string, unknown>): ToolCallResult {
    const fromPath = String(args['from'] ?? '')
    const toPath   = String(args['to'] ?? '')
    if (!fromPath || !toPath) return fail('from and to are required')

    const absFrom = resolve(root, fromPath)
    const absTo   = resolve(root, toPath)
    if (!withinRoot(root, absFrom)) return fail(`Source escapes working root: ${fromPath}`)
    if (!withinRoot(root, absTo))   return fail(`Destination escapes working root: ${toPath}`)
    if (isProtectedSystemWrite(root, absFrom) || isProtectedSystemWrite(root, absTo)) {
        return fail('Direct moves involving agents/*/state.md are protected. Use skill_run(update-agent-state) instead.')
    }
    if (!fs.existsSync(absFrom))    return fail(`Source not found: ${fromPath}`)

    try {
        fs.mkdirSync(path.dirname(absTo), { recursive: true })
        fs.renameSync(absFrom, absTo)
        return ok(`Moved: ${fromPath} → ${toPath}`)
    } catch (e) {
        return fail(`Move failed: ${e instanceof Error ? e.message : String(e)}`)
    }
}

function handlePatch(root: string, args: Record<string, unknown>): ToolCallResult {
    const filePath = String(args['path'] ?? '')
    if (!filePath) return fail('path is required')

    const abs = resolve(root, filePath)
    if (!withinRoot(root, abs)) return fail(`Path escapes working root: ${filePath}`)
    if (isProtectedSystemWrite(root, abs)) {
        return fail(`Direct writes to ${filePath} are protected.`)
    }
    if (!fs.existsSync(abs)) return fail(`File not found: ${filePath}`)
    if (fs.statSync(abs).isDirectory()) return fail(`Path is a directory: ${filePath}`)

    const patches = args['patches']
    if (!Array.isArray(patches) || patches.length === 0) return fail('patches array is required and must not be empty')

    let content: string
    try {
        content = fs.readFileSync(abs, 'utf8')
    } catch (e) {
        return fail(`Read failed: ${e instanceof Error ? e.message : String(e)}`)
    }

    // Validate all patches before applying any (atomic — all or nothing)
    for (let i = 0; i < patches.length; i++) {
        const patch = patches[i] as Record<string, unknown>
        const search = String(patch['search'] ?? '')
        if (!search) return fail(`Patch ${i}: search string is empty`)

        const occurrences = content.split(search).length - 1
        if (occurrences === 0) return fail(`Patch ${i}: search string not found in file.\nSearch: ${search.slice(0, 200)}`)
        if (occurrences > 1)   return fail(`Patch ${i}: search string matches ${occurrences} locations (must be unique).\nSearch: ${search.slice(0, 200)}`)
    }

    // Apply patches sequentially
    for (const patch of patches) {
        const p = patch as Record<string, unknown>
        const search  = String(p['search'] ?? '')
        const replace = String(p['replace'] ?? '')
        content = content.replace(search, replace)
    }

    try {
        fs.writeFileSync(abs, content, 'utf8')
        const bytes = fs.statSync(abs).size
        return ok(`Patched: ${filePath} (${patches.length} replacement${patches.length > 1 ? 's' : ''}, ${bytes} bytes)`, { path: abs, bytes, patchCount: patches.length })
    } catch (e) {
        return fail(`Write failed: ${e instanceof Error ? e.message : String(e)}`)
    }
}

// ── Runtime ───────────────────────────────────────────────────────────────────

interface IToolRuntimeWithMeta extends IToolRuntime {
    mutatingToolNames(): ReadonlySet<string>
}

export class FsToolRuntime implements IToolRuntimeWithMeta {
    constructor(private readonly root: string) {
        fs.mkdirSync(this.root, { recursive: true })
    }

    tools(): ToolDefinition[] {
        return DEFINITIONS
    }

    async call(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
        switch (name) {
            case 'fs_read':   return handleRead(this.root, args)
            case 'fs_write':  return handleWrite(this.root, args)
            case 'fs_patch':  return handlePatch(this.root, args)
            case 'fs_list':   return handleList(this.root, args)
            case 'fs_delete': return handleDelete(this.root, args)
            case 'fs_move':   return handleMove(this.root, args)
            default:          return fail(`Unknown tool: ${name}`)
        }
    }

    mutatingToolNames(): ReadonlySet<string> {
        return new Set(['fs_write', 'fs_patch', 'fs_delete', 'fs_move'])
    }
}
