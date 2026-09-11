import { isDeepStrictEqual } from 'node:util';
import type { ToolDefinition } from '../contracts/llm.js';
import type { IValidatedToolRuntime, ToolCallOptions, ToolCallResult, ToolCallValidation } from '../contracts/tool-runtime.js';

/** Structural subset of Playwright; importing this module never loads a browser driver. */
export interface BrowserPage {
    goto(url: string, options: { timeout: number; waitUntil: 'domcontentloaded' }): Promise<unknown>;
    locator(selector: string): {
        click(options: { timeout: number }): Promise<void>;
        fill(value: string, options: { timeout: number }): Promise<void>;
        ariaSnapshot(options: { timeout: number }): Promise<string>;
    };
    screenshot(options: {
        type: 'png';
        fullPage: false;
        timeout: number
    }): Promise<Uint8Array>;
}
export interface BrowserContext {
    newPage(): Promise<BrowserPage>;
    close(): Promise<void>;
}
export interface BrowserDriver {
    newContext(options: { viewport: { width: number; height: number } }): Promise<BrowserContext>;
    close(): Promise<void>;
}
export interface BrowserToolOptions {
    /** An existing browser is borrowed. A lazily called factory transfers browser ownership. */
    browser: BrowserDriver | (() => Promise<BrowserDriver>);
    timeoutMs?: number;
    maxSnapshotBytes?: number;
    maxScreenshotBytes?: number;
    maxSessions?: number;
}
export interface BrowserToolRuntime extends IValidatedToolRuntime {
    /** Explicitly discard an idle session's browser state; never retries interrupted actions. */
    closeSession(sessionId: string): Promise<void>;
}
const definitions: ToolDefinition[] = [
    {
        name: 'browser_navigate',
        description: 'Navigate the session browser to an HTTP(S) URL. Pages may perform external effects.',
        parameters: {
            type: 'object',
            properties: { url: { type: 'string' } },
            required: ['url'],
            additionalProperties: false
        }
    },
    {
        name: 'browser_click',
        description: 'Click a unique Playwright locator in the session browser. May perform external effects.',
        parameters: {
            type: 'object',
            properties: { selector: { type: 'string' } },
            required: ['selector'],
            additionalProperties: false
        }
    },
    {
        name: 'browser_fill',
        description: 'Fill a unique Playwright locator in the session browser. May trigger external effects.',
        parameters: {
            type: 'object',
            properties: { selector: { type: 'string' }, value: { type: 'string' } },
            required: ['selector', 'value'],
            additionalProperties: false
        }
    },
    {
        name: 'browser_snapshot',
        description: 'Read a bounded accessibility snapshot of the session browser.',
        parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false
        }
    },
    {
        name: 'browser_screenshot',
        description: 'Capture the session browser viewport as a PNG image.',
        parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false
        }
    },
];
const fail = (content: string, errorKind: ToolCallResult['errorKind']): ToolCallResult => ({
    ok: false,
    content,
    errorKind
});
interface Session {
    context?: BrowserContext;
    page?: BrowserPage;
    acquisition?: Promise<void>;
    cleanup?: Promise<void>;
    busy: boolean;
    invalid: boolean
}

/** One isolated context per host-owned session ID. Calls in a session must be sequential. */
export function browserToolRuntime(options: BrowserToolOptions): BrowserToolRuntime {
    const timeout = options.timeoutMs ?? 30000;
    const snapshotLimit = options.maxSnapshotBytes ?? 16000;
    const screenshotLimit = options.maxScreenshotBytes ?? 2 * 1024 * 1024;
    const maxSessions = options.maxSessions ?? 32;
    for (const [name, value] of Object.entries({
        timeoutMs: timeout,
        maxSnapshotBytes: snapshotLimit,
        maxScreenshotBytes: screenshotLimit,
        maxSessions
    })) {
        if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) {
            throw new RangeError(`${name} must be a positive bounded integer`);
        }
    }
    const sessions = new Map<string, Session>();
    const active = new Set<Promise<ToolCallResult>>();
    const shutdown = new AbortController();
    let driver: Promise<BrowserDriver> | undefined;
    let closing: Promise<void> | undefined;
    const getDriver = () => driver ??= Promise.resolve().then(() => typeof options.browser === 'function' ? options.browser() : options.browser);
    const dispose = async (session: Session, drain = false) => {
        session.invalid = true;
        const context = session.context;
        session.context = undefined;
        session.page = undefined;
        if (context) {
            session.cleanup = context.close();
        }
        if (drain) {
            await session.acquisition?.catch(() => { });
        }
        await session.cleanup;
    };
    const validate = (name: string, args: Record<string, unknown>): ToolCallValidation => {
        const definition = definitions.find(tool => tool.name === name);
        if (!definition) {
            return { ok: false, result: fail(`Unknown tool: ${name}`, 'validation') };
        }
        const keys = name === 'browser_navigate' ? ['url'] : name === 'browser_click' ? ['selector'] : name === 'browser_fill' ? ['selector', 'value'] : [];
        if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !keys.includes(key))
            || keys.some(key => typeof args[key] !== 'string' || (key !== 'value' && !(args[key] as string).trim())
                || (args[key] as string).length > (key === 'value' ? 65536 : 4096))) {
            return { ok: false, result: fail('Invalid browser arguments', 'validation') };
        }
        if (name === 'browser_navigate') {
            try {
                const url = new URL(args.url as string);
                if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
                    throw new Error();
                }
            } catch {
                return { ok: false, result: fail('Expected an HTTP(S) URL without embedded credentials', 'validation') };
            }
        }
        return { ok: true, args: { ...args } };
    };
    const run = async (name: string, args: Record<string, unknown>, call: ToolCallOptions = {}): Promise<ToolCallResult> => {
        const checked = validate(name, args);
        if (!checked.ok) {
            return checked.result;
        }
        if (call.authorizedArgs && !isDeepStrictEqual(checked.args, call.authorizedArgs)) {
            return fail('Browser arguments differ from authorization', 'validation');
        }
        if (shutdown.signal.aborted || call.signal?.aborted) {
            return fail('Browser call cancelled before dispatch', 'cancelled');
        }
        if (!call.sessionId?.trim()) {
            return fail('Browser tools require a host-owned sessionId', 'validation');
        }
        let session = sessions.get(call.sessionId);
        if (session?.invalid) {
            return fail('Browser session was interrupted; use a new session identity', 'unknown');
        }
        if (session?.busy) {
            return fail('A browser call is already running in this session', 'runtime');
        }
        if (!session) {
            if (sessions.size >= maxSessions) {
                return fail('Browser session capacity reached', 'runtime');
            }
            session = { busy: false, invalid: false };
            sessions.set(call.sessionId, session);
        }
        session.busy = true;
        const current = session;
        const signal = AbortSignal.any([shutdown.signal, ...(call.signal ? [call.signal] : []), AbortSignal.timeout(timeout)]);
        let dispatched = false;
        let abort: (() => void) | undefined;
        const interrupted = new Promise<never>((_, reject) => {
            abort = () => reject(signal.reason);
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) {
                abort();
            }
        });
        const perform = async (): Promise<ToolCallResult> => {
            if (!current.page) {
                current.acquisition = (async () => {
                    const browser = await getDriver();
                    signal.throwIfAborted();
                    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
                    if (signal.aborted || current.invalid) {
                        current.cleanup = context.close();
                        await current.cleanup;
                        signal.throwIfAborted();
                        throw new Error('Browser session closed');
                    }
                    current.context = context;
                    current.page = await context.newPage();
                })();
                await current.acquisition;
            }
            signal.throwIfAborted();
            if (current.invalid) {
                throw new Error('Browser session closed');
            }
            const page = current.page!;
            dispatched = true;
            if (name === 'browser_navigate') {
                await page.goto(checked.args.url as string, { timeout, waitUntil: 'domcontentloaded' });
            } else if (name === 'browser_click') {
                await page.locator(checked.args.selector as string).click({ timeout });
            } else if (name === 'browser_fill') {
                await page.locator(checked.args.selector as string).fill(checked.args.value as string, { timeout });
            } else if (name === 'browser_snapshot') {
                const snapshot = Buffer.from(await page.locator('body').ariaSnapshot({ timeout }));
                const truncated = snapshot.length > snapshotLimit;
                // Decode only complete UTF-8 characters at the byte boundary.
                const marker = truncated ? (snapshotLimit >= 21 ? '\n[Snapshot truncated]' : '.'.repeat(Math.min(3, snapshotLimit))) : '';
                const text = new TextDecoder().decode(snapshot.subarray(0, snapshotLimit - Buffer.byteLength(marker)), { stream: truncated });
                return {
                    ok: true,
                    content: text + marker,
                    data: { truncated, totalBytes: snapshot.length }
                };
            } else {
                const png = await page.screenshot({
                    type: 'png',
                    fullPage: false,
                    timeout
                });
                if (png.byteLength > screenshotLimit) {
                    return fail(`Screenshot exceeds ${screenshotLimit} bytes`, 'runtime');
                }
                return {
                    ok: true,
                    content: 'Browser viewport screenshot.',
                    contentBlocks: [{
                        type: 'image',
                        mimeType: 'image/png',
                        data: Buffer.from(png).toString('base64')
                    }]
                };
            }
            return { ok: true, content: `${name} completed. Use browser_snapshot or browser_screenshot to inspect the page.` };
        };
        try {
            return await Promise.race([perform(), interrupted]);
        } catch (error) {
            try {
                await dispose(current);
            } catch (cleanup) {
                return fail(`Browser outcome uncertain; context cleanup failed: ${String(cleanup)}`, 'unknown');
            }
            return fail(String(error), dispatched ? 'unknown' : signal.aborted ? (signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled') : 'runtime');
        } finally {
            signal.removeEventListener('abort', abort!);
            current.busy = false;
        }
    };
    return {
        tools: () => structuredClone(definitions),
        validate,
        // Even navigation and DOM inspection can interact with a live application.
        effectFor: name => definitions.some(tool => tool.name === name) ? 'write' : undefined,
        call(name, args, call) {
            const pending = run(name, args, call).catch(error => fail(String(error), 'unknown'));
            active.add(pending);
            void pending.finally(() => active.delete(pending));
            return pending;
        },
        async closeSession(sessionId) {
            const session = sessions.get(sessionId);
            if (!session) {
                return;
            }
            if (session.busy) {
                throw new Error('Cannot release an active browser session');
            }
            await dispose(session, true);
            sessions.delete(sessionId);
        },
        close() {
            return closing ??= (async () => {
                shutdown.abort(new Error('Browser runtime closing'));
                await Promise.allSettled([...active]);
                const results = await Promise.allSettled([...sessions.values()].map(session => dispose(session, true)));
                if (driver && typeof options.browser === 'function') {
                    try {
                        await (await driver).close();
                    } catch (error) {
                        results.push({ status: 'rejected', reason: error });
                    }
                }
                const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
                if (errors.length) {
                    throw new AggregateError(errors, 'Browser cleanup failed');
                }
            })();
        },
    };
}
