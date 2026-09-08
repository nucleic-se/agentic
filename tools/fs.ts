import { fsReadSchema, fsWriteSchema } from './fs-schema.js';
import { z } from 'zod';
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
import { open, opendir } from 'node:fs/promises'
import type { ToolDefinition } from '../contracts/llm.js'
import type { IToolRuntime, ToolCallResult, ToolCallOptions } from '../contracts/tool-runtime.js'

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
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false
    // Reject symlinks in every existing component, including dangling links.
    let current = path.resolve(root)
    for (const part of rel.split(path.sep).filter(Boolean)) {
        current = path.join(current, part)
        try { if (fs.lstatSync(current).isSymbolicLink()) return false }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false }
    }
    return true
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const DEFINITIONS: ToolDefinition[] = [
    {
        name:        'fs_read',
        description: 'Read a regular file, with a 256 KiB output ceiling. UTF-8 reads return numbered lines, defaulting to 200 lines. Use search_grep to locate relevant code, then offset/limit for focused reads; truncated ranges include nextOffset. A single oversized line is rejected. totalLines is available only after EOF.',
        parameters: {
            type: 'object',
            required: ['path'],
            properties: {
                path:     { type: 'string', description: 'File path (relative to working root or absolute).' },
                encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Encoding. Default: utf8.' },
                mode:     { type: 'string', enum: ['lines', 'bytes'], description: 'Default: lines. Bytes mode reads exact UTF-8 text with zero-based byte offset and a byte limit up to 16000; returns JSON with nextOffset/eof. Use for long records.' },
                offset:   { type: 'integer', description: 'Lines mode: 1-based line number, default 1. Bytes mode: zero-based byte position, default 0.' },
                limit:    { type: 'integer', description: 'Lines mode: maximum lines, default 200. Bytes mode: maximum bytes, default and maximum 16000.' },
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

async function handleRead(root: string, args: Record<string, unknown>, textPageBytes: number, options?: ToolCallOptions): Promise<ToolCallResult> {
    const checked = fsReadSchema.safeParse(args)
    if (!checked.success) return fail(checked.error.message)
    args = checked.data
    const filePath = String(args['path'] ?? '')
    if (!filePath) return fail('path is required')
    const abs = resolve(root, filePath)
    if (!withinRoot(root, abs)) return fail(`Path escapes working root: ${filePath}`)
    const mode = args.mode ?? 'lines'
    if (mode !== 'lines' && mode !== 'bytes') return fail('mode must be lines or bytes')
    const hasLineRange = args.offset !== undefined || args.limit !== undefined
    const offset = args.offset === undefined ? (mode === 'bytes' ? 0 : 1) : args.offset
    const limit = args.limit === undefined ? (mode === 'bytes' ? 16000 : 200) : args.limit
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < (mode === 'bytes' ? 0 : 1) ||
        typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) return fail('offset and limit must be positive safe integers')
    const encoding = args.encoding ?? 'utf8'
    if (encoding !== 'utf8' && encoding !== 'base64') return fail('encoding must be utf8 or base64')
    if (mode === 'bytes' && (encoding !== 'utf8' || limit > 16000)) return fail('Byte pages require UTF-8 and a limit no greater than 16000')
    if (hasLineRange && encoding !== 'utf8') return fail('Line ranges require utf8 encoding')
    let file: Awaited<ReturnType<typeof open>> | undefined
    try {
        options?.signal?.throwIfAborted()
        // NONBLOCK prevents a FIFO open from waiting for a writer before we can inspect it.
        file = await open(abs, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW)
        const stat = await file.stat()
        if (!stat.isFile()) return fail('Not a regular file')
        if (mode === 'bytes') {
            const page = Buffer.alloc(limit)
            const { bytesRead } = await file.read(page, 0, limit, offset)
            options?.signal?.throwIfAborted()
            const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
            const content = decoder.decode(page.subarray(0, bytesRead), { stream: offset + bytesRead < stat.size })
            const consumed = Buffer.byteLength(content, 'utf8')
            if (bytesRead > 0 && consumed === 0) return fail('Read limit cannot fit the next UTF-8 character; increase limit')
            const nextOffset = offset + consumed
            return ok(JSON.stringify({ bytes: stat.size, offset, bytesRead: consumed, nextOffset, eof: nextOffset >= stat.size, content }))
        }
        const buffer = Buffer.alloc(8192)
        if (encoding === 'base64') {
            if (stat.size > MAX_READ_BYTES) return fail(`File too large: ${stat.size} bytes (max ${MAX_READ_BYTES}). Use offset/limit to read a line range.`)
            const chunks: Buffer[] = []
            let bytes = 0
            while (true) {
                options?.signal?.throwIfAborted()
                const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
                if (!bytesRead) break
                bytes += bytesRead
                if (bytes > MAX_READ_BYTES) return fail('File grew beyond read limit')
                chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
            }
            const content = Buffer.concat(chunks).toString(encoding)
            if (Buffer.byteLength(content) > MAX_READ_BYTES) return fail('Encoded file exceeds output limit; use a UTF-8 line range')
            return ok(content, { path: abs, bytes: stat.size })
        }
        const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
        const lines: string[] = []
        let lineNumber = 1, line = '', outputBytes = 0, eof = false, stopped = false
        const emitLine = () => {
            if (lineNumber < offset) { lineNumber++; return }
            const numbered = `${lineNumber}: ${line}`
            const size = Buffer.byteLength(numbered) + (lines.length ? 1 : 0)
            if (outputBytes + size > textPageBytes - 100) { stopped = true; return false }
            lines.push(numbered); outputBytes += size; lineNumber++; line = ''
            if (lines.length >= limit) stopped = true
        }
        while (!stopped) {
            options?.signal?.throwIfAborted()
            const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
            const text = decoder.decode(buffer.subarray(0, bytesRead), { stream: bytesRead > 0 })
            let start = 0
            for (let i = 0; i <= text.length; i++) {
                if (i < text.length && text[i] !== '\n') continue
                if (lineNumber >= offset) {
                    line += text.slice(start, i)
                    if (Buffer.byteLength(line) + String(lineNumber).length + 2 > textPageBytes - 100)
                        return fail(`Line ${lineNumber} exceeds the ${textPageBytes}-byte output limit; use mode: "bytes" for exact byte pages`)
                }
                if (i < text.length) emitLine()
                start = i + 1
                if (stopped) break
            }
            if (!bytesRead) { eof = emitLine() !== false; break }
        }
        const content = lines.join('\n') + (!eof ? `\n[truncated; continue with offset: ${lineNumber}]` : '')
        return ok(content, { path: abs, bytes: stat.size, startLine: offset,
            endLine: offset + lines.length - 1, linesReturned: lines.length,
            ...(eof ? { totalLines: lineNumber - 1 } : {}), truncated: !eof,
            ...(!eof ? { nextOffset: lineNumber } : {}) })
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fail(`File not found: ${filePath}`)
        return options?.signal?.aborted
            ? { ok: false, content: 'Read cancelled', errorKind: 'cancelled' }
            : fail(`Read failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally { await file?.close() }
}

function handleWrite(root: string, args: Record<string, unknown>): ToolCallResult {
    const checked = fsWriteSchema.safeParse(args)
    if (!checked.success) return fail(checked.error.message)
    args = checked.data
    const filePath = String(args['path'] ?? '')
    const content  = String(args['content'] ?? '')
    const append   = Boolean(args['append'] ?? false)
    if (!filePath) return fail('path is required')

    const abs = resolve(root, filePath)
    if (!withinRoot(root, abs)) return fail(`Path escapes working root: ${filePath}`)
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

async function handleList(root: string, args: Record<string, unknown>, options?: ToolCallOptions): Promise<ToolCallResult> {
    const dirPath   = String(args['path'] ?? '.')
    const recursive = Boolean(args['recursive'] ?? false)

    const abs = resolve(root, dirPath)
    if (!withinRoot(root, abs)) return fail(`Path escapes working root: ${dirPath}`)
    if (!fs.existsSync(abs)) return fail(`Directory not found: ${dirPath}`)
    if (!fs.statSync(abs).isDirectory()) return fail(`Not a directory: ${dirPath}`)

    try {
        const entries: string[] = []
        async function collect(dir: string, prefix: string) {
            if (entries.length >= MAX_LIST_ITEMS) return
            for await (const entry of await opendir(dir)) {
                options?.signal?.throwIfAborted()
                if (entries.length >= MAX_LIST_ITEMS) break
                const rel = prefix ? `${prefix}/${entry.name}` : entry.name
                entries.push(entry.isDirectory() ? `${rel}/` : rel)
                if (recursive && entry.isDirectory()) await collect(path.join(dir, entry.name), rel)
            }
        }
        await collect(abs, '')
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
    if (abs === path.resolve(root)) return fail('Workspace root cannot be deleted')
    if (!withinRoot(root, abs)) return fail(`Path escapes working root: ${filePath}`)
    if (!fs.existsSync(abs)) return fail(`File not found: ${filePath}`)

    try {
        fs.rmSync(abs, { recursive: true })
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
    if (absFrom === path.resolve(root) || absTo === path.resolve(root)) return fail('Workspace root cannot be moved or replaced')
    if (!withinRoot(root, absFrom)) return fail(`Source escapes working root: ${fromPath}`)
    if (!withinRoot(root, absTo))   return fail(`Destination escapes working root: ${toPath}`)

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

    // Apply to a working copy; commit only after every sequential operation validates.
    for (let i = 0; i < patches.length; i++) {
        const patch = patches[i] as Record<string, unknown>
        if (!patch || typeof patch !== 'object') return fail(`Patch ${i}: invalid operation`)
        const search = String(patch['search'] ?? '')
        if (!search) return fail(`Patch ${i}: search string is empty`)

        const occurrences = content.split(search).length - 1
        if (occurrences === 0) return fail(`Patch ${i}: search string not found in file.\nSearch: ${search.slice(0, 200)}`)
        if (occurrences > 1)   return fail(`Patch ${i}: search string matches ${occurrences} locations (must be unique).\nSearch: ${search.slice(0, 200)}`)
        content = content.replace(search, () => String(patch['replace'] ?? ''))
        if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) return fail('Patched content too large')
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
    private readonly textPageBytes: number

    constructor(private readonly root: string, options: { textPageBytes?: number } = {}) {
        this.textPageBytes = options.textPageBytes ?? MAX_READ_BYTES
        if (!Number.isSafeInteger(this.textPageBytes) || this.textPageBytes < 256 || this.textPageBytes > MAX_READ_BYTES)
            throw new RangeError(`textPageBytes must be an integer between 256 and ${MAX_READ_BYTES}`)
        fs.mkdirSync(this.root, { recursive: true })
    }

    tools(): ToolDefinition[] {
        const definitions = structuredClone(DEFINITIONS)
        definitions[0].description = `Read a regular file. UTF-8 pages contain complete numbered lines, up to ${this.textPageBytes} bytes including the continuation marker and at most 200 lines by default. Follow nextOffset for the next page; offset/limit select lines. A single line larger than the page is rejected. totalLines is available only after EOF. Base64 reads return the complete encoding, at most 256 KiB of encoded output; ranges require UTF-8.`
        for (const tool of definitions) {
            const schema = tool.name === 'fs_read' ? fsReadSchema : tool.name === 'fs_write' ? fsWriteSchema : undefined
            if (schema) tool.parameters = { ...z.toJSONSchema(schema), type: 'object' } as ToolDefinition['parameters']
        }
        return definitions
    }

    async call(name: string, args: Record<string, unknown>, options?: ToolCallOptions): Promise<ToolCallResult> {
        switch (name) {
            case 'fs_read':   return handleRead(this.root, args, this.textPageBytes, options)
            case 'fs_write':  return handleWrite(this.root, args)
            case 'fs_patch':  return handlePatch(this.root, args)
            case 'fs_list':   return handleList(this.root, args, options)
            case 'fs_delete': return handleDelete(this.root, args)
            case 'fs_move':   return handleMove(this.root, args)
            default:          return fail(`Unknown tool: ${name}`)
        }
    }

    mutatingToolNames(): ReadonlySet<string> {
        return new Set(['fs_write', 'fs_patch', 'fs_delete', 'fs_move'])
    }
}
