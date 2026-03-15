import type { ToolDefinition } from '../contracts/llm.js'
import type { IToolRuntime, ToolCallResult } from '../contracts/tool-runtime.js'

const MAX_RESULTS = 8
const MAX_BODY_CHARS = 12_000
const TIMEOUT_MS = 15_000

function ok(content: string, data?: unknown): ToolCallResult {
    return { ok: true, content, data }
}

function fail(content: string): ToolCallResult {
    return { ok: false, content }
}

function decodeHtml(text: string): string {
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/gi, "'")
        .replace(/&nbsp;/g, ' ')
}

function stripTags(text: string): string {
    return decodeHtml(text.replace(/<[^>]+>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim()
}

function truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text
    return `${text.slice(0, maxChars - 14)}\n[truncated]`
}

async function fetchText(url: string, headers: Record<string, string> = {}): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
        return await fetch(url, {
            headers: {
                'User-Agent': 'nucleic-agent/0.1 (+https://nucleic.sh)',
                'Accept-Language': 'en-US,en;q=0.8',
                ...headers,
            },
            signal: controller.signal,
            redirect: 'follow',
        })
    } finally {
        clearTimeout(timer)
    }
}

function cleanHtmlToText(html: string): { title: string; text: string } {
    const title = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')

    let content = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
        .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
        .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
        .replace(/<header[\s\S]*?<\/header>/gi, ' ')

    const article = content.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1]
    const main = content.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1]
    const body = content.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1]
    content = article ?? main ?? body ?? content

    content = content
        .replace(/<(br|\/p|\/div|\/li|\/section|\/h[1-6])\b[^>]*>/gi, '\n')
        .replace(/<li\b[^>]*>/gi, '- ')
        .replace(/<\/tr>/gi, '\n')
        .replace(/<\/(td|th)>/gi, ' | ')

    const text = stripTags(content)
        .replace(/\n{3,}/g, '\n\n')
        .trim()

    return {
        title,
        text: truncate(text, MAX_BODY_CHARS),
    }
}

function parseDuckDuckGoResults(html: string, maxResults: number): Array<{ title: string; url: string; snippet: string }> {
    const results: Array<{ title: string; url: string; snippet: string }> = []
    const blocks = html.split(/<div[^>]+class="result[^"]*"[^>]*>/i).slice(1)

    for (const block of blocks) {
        const href = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"/i)?.[1]
        const titleHtml = block.match(/<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/i)?.[1]
        const snippetHtml = block.match(/<(?:a|div)[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/i)?.[1] ?? ''
        if (!href || !titleHtml) continue
        results.push({
            title: stripTags(titleHtml),
            url: decodeHtml(href),
            snippet: stripTags(snippetHtml),
        })
        if (results.length >= maxResults) break
    }

    return results
}

async function handleSearch(args: Record<string, unknown>): Promise<ToolCallResult> {
    const query = String(args['query'] ?? '').trim()
    const maxResults = Math.max(1, Math.min(MAX_RESULTS, Number(args['max_results'] ?? 5)))
    if (!query) return fail('query is required')

    try {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
        const res = await fetchText(url)
        const html = await res.text()
        if (!res.ok) return fail(`Search failed: HTTP ${res.status} ${res.statusText}`)

        const results = parseDuckDuckGoResults(html, maxResults)
        if (results.length === 0) return fail('Search returned no parseable results.')

        return ok(results.map((result, index) => [
            `${index + 1}. ${result.title}`,
            `URL: ${result.url}`,
            result.snippet ? `Snippet: ${result.snippet}` : '',
        ].filter(Boolean).join('\n')).join('\n\n'), { results })
    } catch (err) {
        return fail(`Search failed: ${err instanceof Error ? err.message : String(err)}`)
    }
}

async function handleFetchClean(args: Record<string, unknown>): Promise<ToolCallResult> {
    const url = String(args['url'] ?? '').trim()
    if (!url) return fail('url is required')

    try {
        const res = await fetchText(url)
        const raw = await res.text()
        if (!res.ok) return fail(`Fetch failed: HTTP ${res.status} ${res.statusText}`)

        const contentType = res.headers.get('content-type') ?? 'unknown'
        if (!/html|xml/i.test(contentType)) {
            return ok([
                `URL: ${url}`,
                `Content-Type: ${contentType}`,
                'Body:',
                truncate(raw, MAX_BODY_CHARS),
            ].join('\n'))
        }

        const cleaned = cleanHtmlToText(raw)
        return ok([
            `URL: ${url}`,
            cleaned.title ? `Title: ${cleaned.title}` : '',
            `Content-Type: ${contentType}`,
            'Cleaned text:',
            cleaned.text,
        ].filter(Boolean).join('\n'))
    } catch (err) {
        return fail(`Fetch failed: ${err instanceof Error ? err.message : String(err)}`)
    }
}

const DEFINITIONS: ToolDefinition[] = [
    {
        name: 'web_search',
        description: 'Search the web for a topic using a lightweight search engine. Prefer this for basic online research before fetching individual sources.',
        parameters: {
            type: 'object',
            required: ['query'],
            properties: {
                query: { type: 'string', description: 'Search query. Keep it specific and source-oriented when possible.' },
                max_results: { type: 'number', description: 'Maximum number of results to return (1-8).' },
            },
        },
    },
    {
        name: 'web_fetch_clean',
        description: 'Fetch a web page and return cleaned readable text. Best for lean article/documentation pages after selecting a source.',
        parameters: {
            type: 'object',
            required: ['url'],
            properties: {
                url: { type: 'string', description: 'Absolute URL to fetch.' },
            },
        },
    },
]

export class WebToolRuntime implements IToolRuntime {
    tools(): ToolDefinition[] {
        return DEFINITIONS
    }

    async call(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
        switch (name) {
            case 'web_search':
                return handleSearch(args)
            case 'web_fetch_clean':
                return handleFetchClean(args)
            default:
                return fail(`Unknown tool: ${name}`)
        }
    }
}
