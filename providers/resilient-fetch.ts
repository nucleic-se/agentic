/**
 * Shared retry logic for HTTP providers.
 *
 * Exponential backoff with jitter, respects `retry-after` / `retry-after-ms`
 * and common rate-limit reset headers.  Used by both Anthropic and
 * OpenAI-compatible providers.
 */

// ── Defaults ───────────────────────────────────────────────────────────────────

const DEFAULT_MAX_RETRIES   = 6
const DEFAULT_BASE_DELAY_MS = 2_000
const DEFAULT_MAX_DELAY_MS  = 60_000
const DEFAULT_RETRYABLE     = new Set([429, 502, 503, 529])

// ── Config ─────────────────────────────────────────────────────────────────────

export interface RetryConfig {
    /** HTTP status codes to retry on. Default: 429, 502, 503, 529. */
    retryableStatuses?: ReadonlySet<number>
    /** Max retry attempts (not counting the first request). Default: 6. */
    maxRetries?: number
    /** Base delay in ms for the first retry. Default: 2 000. */
    baseDelayMs?: number
    /** Ceiling on any single delay. Default: 60 000. */
    maxDelayMs?: number
    /** Called before each retry sleep. Useful for logging. */
    onRetry?: (attempt: number, delayMs: number, status: number) => void
    /**
     * Extra response-header names to inspect for delay overrides
     * (in addition to the standard `retry-after` / `retry-after-ms`).
     */
    resetHeaders?: string[]
}

// ── Public helpers ─────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Compute the exponential-backoff delay for a given attempt, with ±20 % jitter.
 */
export function retryDelay(
    attempt: number,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs  = DEFAULT_MAX_DELAY_MS,
): number {
    const exp    = baseDelayMs * 2 ** attempt
    const capped = Math.min(exp, maxDelayMs)
    const jitter = Math.random() * capped * 0.2   // ±20 %
    return Math.round(capped + jitter)
}

export function parseResetHeader(value: string | null): number | null {
    if (!value) return null

    const numeric = Number(value)
    if (Number.isFinite(numeric)) {
        // Small values → delta-seconds; large → epoch-ms.
        return numeric > 1e12
            ? Math.max(0, numeric - Date.now())
            : Math.max(0, numeric * 1000)
    }

    const asDate = Date.parse(value)
    if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now())

    return null
}

/**
 * Derive the retry delay from response headers, falling back to exponential
 * backoff when no header provides a value.
 */
export function retryDelayFromHeaders(
    headers: Headers,
    attempt: number,
    extraResetHeaders: string[] = [],
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs  = DEFAULT_MAX_DELAY_MS,
): number {
    // Prefer explicit retry-after-ms (milliseconds)
    const retryAfterMs = headers.get('retry-after-ms')
    if (retryAfterMs) {
        const parsed = Number(retryAfterMs)
        if (Number.isFinite(parsed) && parsed > 0) {
            return Math.min(parsed, maxDelayMs)
        }
    }

    // Standard retry-after (seconds or HTTP-date)
    const retryAfter = headers.get('retry-after')
    if (retryAfter) {
        const numeric = Number(retryAfter)
        if (Number.isFinite(numeric) && numeric > 0) {
            return Math.min(numeric * 1000, maxDelayMs)
        }
        const asDate = Date.parse(retryAfter)
        if (!Number.isNaN(asDate)) {
            return Math.min(Math.max(0, asDate - Date.now()), maxDelayMs)
        }
    }

    // Provider-specific reset headers (e.g. x-ratelimit-reset-requests)
    const allResetHeaders = [
        'x-ratelimit-reset-requests',
        'x-ratelimit-reset-tokens',
        ...extraResetHeaders,
    ]

    const delays = allResetHeaders
        .map(name => parseResetHeader(headers.get(name)))
        .filter((v): v is number => v != null && v > 0)

    if (delays.length > 0) {
        return Math.min(Math.max(...delays), maxDelayMs)
    }

    return retryDelay(attempt, baseDelayMs, maxDelayMs)
}

// ── Rate-limiter (per-key request spacing) ─────────────────────────────────────

const nextRequestAt   = new Map<string, number>()
const requestStartGate = new Map<string, Promise<void>>()

/**
 * Per-key request rate limiting.  Awaiting this guarantees at least
 * `minSpacingMs` between consecutive request starts for the same key.
 */
export async function waitForRequestSlot(key: string, minSpacingMs: number): Promise<void> {
    const previous = requestStartGate.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    requestStartGate.set(key, previous.then(() => current))

    await previous
    try {
        const now  = Date.now()
        const next = nextRequestAt.get(key) ?? 0
        if (next > now) await sleep(next - now)
        nextRequestAt.set(key, Date.now() + minSpacingMs)
    } finally {
        release()
        if (requestStartGate.get(key) === current) requestStartGate.delete(key)
    }
}

/** Push the next-request-allowed timestamp for a key forward by `delayMs`. */
export function pushBackRequestSlot(key: string, delayMs: number): void {
    const candidate = Date.now() + delayMs
    nextRequestAt.set(key, Math.max(nextRequestAt.get(key) ?? 0, candidate))
}

// ── Core: resilient POST ───────────────────────────────────────────────────────

/**
 * `fetch()` wrapper with automatic retry on transient HTTP errors.
 *
 * Returns the parsed JSON body on success.  Throws on non-retryable errors
 * or after exhausting all retry attempts.
 */
export async function resilientPost<T>(
    url: string,
    init: RequestInit,
    providerName: string,
    config: RetryConfig = {},
): Promise<T> {
    const retryable   = config.retryableStatuses ?? DEFAULT_RETRYABLE
    const maxRetries  = config.maxRetries   ?? DEFAULT_MAX_RETRIES
    const baseDelay   = config.baseDelayMs  ?? DEFAULT_BASE_DELAY_MS
    const maxDelay    = config.maxDelayMs   ?? DEFAULT_MAX_DELAY_MS
    const resetHdrs   = config.resetHeaders ?? []

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const res = await fetch(url, init)

        if (res.ok) return res.json() as Promise<T>

        if (retryable.has(res.status) && attempt < maxRetries) {
            const delay = retryDelayFromHeaders(res.headers, attempt, resetHdrs, baseDelay, maxDelay)
            config.onRetry?.(attempt + 1, delay, res.status)
            await res.body?.cancel()
            await sleep(delay)
            continue
        }

        const text = await res.text().catch(() => '(no body)')
        throw new Error(`${providerName}: HTTP ${res.status} ${res.statusText} — ${text}`)
    }

    throw new Error(`${providerName}: max retries exceeded`)
}
