/**
 * Fetch tools — HTTP GET and POST.
 *
 * Uses the global fetch (Node 18+). Returns response body as text,
 * truncated if it exceeds the size limit. Status codes, headers, and
 * errors are all surfaced in the content string so the LLM can reason
 * about them.
 */

import type { ToolDefinition } from '../contracts/llm.js'
import type { IToolRuntime, ToolCallResult } from '../contracts/tool-runtime.js'

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

async function handleGet(args: Record<string, unknown>): Promise<ToolCallResult> {
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

async function handlePost(args: Record<string, unknown>): Promise<ToolCallResult> {
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

export class FetchToolRuntime implements IToolRuntime {
    tools(): ToolDefinition[] {
        return DEFINITIONS
    }

    async call(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
        switch (name) {
            case 'fetch_get':  return handleGet(args)
            case 'fetch_post': return handlePost(args)
            default:           return { ok: false, content: `Unknown tool: ${name}` }
        }
    }
}
