/**
 * Fetch tools — HTTP GET and POST.
 *
 * Uses the global fetch (Node 18+). Returns response body as text,
 * truncated if it exceeds the size limit. Status codes, headers, and
 * errors are all surfaced in the content string so the LLM can reason
 * about them.
 *
 * When `outputDir` is provided, response bodies are written to disk and
 * the tool returns the file path instead of inlining the content. This
 * keeps large responses out of the conversation context — the model reads
 * the file with fs_read when it needs the content.
 */

import type { ToolDefinition } from '../contracts/llm.js'
import type { IToolRuntime, ToolCallResult } from '../contracts/tool-runtime.js'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ── Limits ────────────────────────────────────────────────────────────────────

const MAX_RESPONSE_BYTES = 128 * 1024   // 128 KB
const TIMEOUT_MS         = 15_000

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(content: string, data?: unknown): ToolCallResult {
    return { ok: true, content, data }
}

function fail(content: string): ToolCallResult {
    return { ok: false, content }
}

function truncate(text: string, maxBytes: number): { text: string; truncated: boolean } {
    const buf = Buffer.from(text, 'utf8')
    if (buf.byteLength <= maxBytes) return { text, truncated: false }
    return { text: buf.slice(0, maxBytes).toString('utf8') + '\n[truncated]', truncated: true }
}

function saveToFile(outputDir: string, url: string, content: string, ext: string): string {
    mkdirSync(outputDir, { recursive: true })
    const hash = createHash('sha1').update(url).digest('hex').slice(0, 8)
    const filename = `fetch-${hash}-${Date.now()}.${ext}`
    const filePath = join(outputDir, filename)
    writeFileSync(filePath, content, 'utf8')
    return filePath
}

// ── Definitions ───────────────────────────────────────────────────────────────

const DEFINITIONS: ToolDefinition[] = [
    {
        name:        'fetch_get',
        description: 'Perform an HTTP GET request. Returns status, headers summary, and body.',
        parameters: {
            type: 'object',
            required: ['url'],
            properties: {
                url:     { type: 'string', description: 'The URL to fetch.' },
                headers: { type: 'object', description: 'Optional request headers.' },
            },
        },
    },
    {
        name:        'fetch_post',
        description: 'Perform an HTTP POST request with a JSON or text body.',
        parameters: {
            type: 'object',
            required: ['url', 'body'],
            properties: {
                url:          { type: 'string', description: 'The URL to POST to.' },
                body:         { type: 'string', description: 'Request body. Object → JSON, string → text/plain.' },
                headers:      { type: 'object', description: 'Optional request headers.' },
                content_type: { type: 'string', description: 'Content-Type override. Default: application/json for objects, text/plain for strings.' },
            },
        },
    },
]

// ── Handlers ──────────────────────────────────────────────────────────────────

async function handleGet(args: Record<string, unknown>, outputDir?: string): Promise<ToolCallResult> {
    const url = String(args['url'] ?? '')
    if (!url) return fail('url is required')

    const headers = (args['headers'] ?? {}) as Record<string, string>

    try {
        const controller = new AbortController()
        const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS)

        let res: Response
        try {
            res = await fetch(url, { headers, signal: controller.signal })
        } finally {
            clearTimeout(timer)
        }

        const raw = await res.text()
        const { text: body, truncated } = truncate(raw, MAX_RESPONSE_BYTES)

        if (outputDir) {
            const ext = /json/i.test(res.headers.get('content-type') ?? '') ? 'json' : 'txt'
            const filePath = saveToFile(outputDir, url, body, ext)
            return ok(
                `GET ${url}\nHTTP ${res.status} ${res.statusText}\nContent-Type: ${res.headers.get('content-type') ?? 'unknown'}\nSize: ${(Buffer.byteLength(raw, 'utf8') / 1024).toFixed(1)} KB${truncated ? ' (truncated)' : ''}\nSaved to: ${filePath}`,
                { status: res.status, truncated, filePath },
            )
        }

        const summary = [
            `HTTP ${res.status} ${res.statusText}`,
            `Content-Type: ${res.headers.get('content-type') ?? 'unknown'}`,
            truncated ? `Body (truncated at ${MAX_RESPONSE_BYTES} bytes):` : 'Body:',
            body,
        ].join('\n')

        return ok(summary, { status: res.status, truncated, bytes: Buffer.byteLength(raw, 'utf8') })
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return fail(`GET ${url} failed: ${msg}`)
    }
}

async function handlePost(args: Record<string, unknown>, outputDir?: string): Promise<ToolCallResult> {
    const url  = String(args['url'] ?? '')
    const body = args['body']
    if (!url)              return fail('url is required')
    if (body === undefined) return fail('body is required')

    const isObject   = typeof body === 'object' && body !== null
    const bodyText   = isObject ? JSON.stringify(body) : String(body)
    const defaultCt  = isObject ? 'application/json' : 'text/plain'
    const contentType = String(args['content_type'] ?? defaultCt)
    const headers    = { 'Content-Type': contentType, ...((args['headers'] ?? {}) as Record<string, string>) }

    try {
        const controller = new AbortController()
        const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS)

        let res: Response
        try {
            res = await fetch(url, { method: 'POST', headers, body: bodyText, signal: controller.signal })
        } finally {
            clearTimeout(timer)
        }

        const raw = await res.text()
        const { text: resBody, truncated } = truncate(raw, MAX_RESPONSE_BYTES)

        if (outputDir) {
            const ext = /json/i.test(res.headers.get('content-type') ?? '') ? 'json' : 'txt'
            const filePath = saveToFile(outputDir, `${url}-${bodyText.slice(0, 64)}`, resBody, ext)
            return ok(
                `POST ${url}\nHTTP ${res.status} ${res.statusText}\nContent-Type: ${res.headers.get('content-type') ?? 'unknown'}\nSize: ${(Buffer.byteLength(raw, 'utf8') / 1024).toFixed(1)} KB${truncated ? ' (truncated)' : ''}\nSaved to: ${filePath}`,
                { status: res.status, truncated, filePath },
            )
        }

        const summary = [
            `HTTP ${res.status} ${res.statusText}`,
            `Content-Type: ${res.headers.get('content-type') ?? 'unknown'}`,
            truncated ? `Body (truncated at ${MAX_RESPONSE_BYTES} bytes):` : 'Body:',
            resBody,
        ].join('\n')

        return ok(summary, { status: res.status, truncated, bytes: Buffer.byteLength(raw, 'utf8') })
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return fail(`POST ${url} failed: ${msg}`)
    }
}

// ── Runtime ───────────────────────────────────────────────────────────────────

export interface FetchToolOptions {
    /** If set, response bodies are written to this directory and the tool
     *  returns the file path instead of inlining content in the conversation. */
    outputDir?: string
}

export class FetchToolRuntime implements IToolRuntime {
    private readonly outputDir?: string

    constructor(options?: FetchToolOptions) {
        this.outputDir = options?.outputDir
    }

    tools(): ToolDefinition[] {
        return DEFINITIONS
    }

    async call(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
        switch (name) {
            case 'fetch_get':  return handleGet(args, this.outputDir)
            case 'fetch_post': return handlePost(args, this.outputDir)
            default:           return { ok: false, content: `Unknown tool: ${name}` }
        }
    }
}
