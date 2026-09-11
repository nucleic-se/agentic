import { describe, expect, it, vi } from 'vitest';
import { browserToolRuntime, type BrowserDriver, type BrowserContext, type BrowserPage } from './browser.js';

function fixture() {
    const pages: Array<BrowserPage & { snapshot: string; url: string }> = [];
    const contexts: BrowserContext[] = [];
    const browser: BrowserDriver = {
        newContext: vi.fn(async () => {
            const page = {
                snapshot: '- button "Save"', url: '',
                goto: vi.fn(async (url: string) => { page.url = url; }),
                locator: vi.fn(() => ({ click: vi.fn(async () => {}), fill: vi.fn(async () => {}), ariaSnapshot: vi.fn(async () => page.snapshot) })),
                screenshot: vi.fn(async () => new Uint8Array([1, 2, 3])),
            };
            pages.push(page);
            const context = { newPage: vi.fn(async () => page), close: vi.fn(async () => {}) };
            contexts.push(context);
            return context;
        }),
        close: vi.fn(async () => {}),
    };
    return { browser, pages, contexts };
}

describe('optional browser runtime', () => {
    it('does not acquire resources during discovery, validation, or pre-dispatch rejection', async () => {
        const f = fixture(), factory = vi.fn(async () => f.browser);
        const runtime = browserToolRuntime({ browser: factory });
        expect(runtime.tools()).toHaveLength(5);
        expect(runtime.validate('browser_navigate', { url: 'file:///etc/passwd' }).ok).toBe(false);
        expect((await runtime.call('browser_snapshot', {})).errorKind).toBe('validation');
        expect((await runtime.call('browser_snapshot', {}, { sessionId: 'a', signal: AbortSignal.abort() })).errorKind).toBe('cancelled');
        expect((await runtime.call('browser_navigate', { url: 'https://example.test' }, { sessionId: 'a', authorizedArgs: { url: 'https://other.test' } })).errorKind).toBe('validation');
        await runtime.close?.();
        expect(factory).not.toHaveBeenCalled();
    });

    it('isolates contexts and releases only owned resources', async () => {
        const f = fixture(), runtime = browserToolRuntime({ browser: f.browser });
        await runtime.call('browser_navigate', { url: 'https://a.test' }, { sessionId: 'a' });
        await runtime.call('browser_navigate', { url: 'https://b.test' }, { sessionId: 'b' });
        await runtime.call('browser_snapshot', {}, { sessionId: 'a' });
        expect(f.pages.map(page => page.url)).toEqual(['https://a.test', 'https://b.test']);
        await runtime.close?.();
        expect(f.contexts.every(context => vi.mocked(context.close).mock.calls.length === 1)).toBe(true);
        expect(f.browser.close).not.toHaveBeenCalled();
    });

    it('bounds UTF-8 snapshots and projects screenshots as image blocks', async () => {
        const f = fixture(), runtime = browserToolRuntime({ browser: f.browser, maxSnapshotBytes: 24 });
        await runtime.call('browser_snapshot', {}, { sessionId: 'a' });
        f.pages[0].snapshot = 'é'.repeat(20);
        const result = await runtime.call('browser_snapshot', {}, { sessionId: 'a' });
        expect(result.content).toBe('é\n[Snapshot truncated]');
        expect(result.data).toEqual({ truncated: true, totalBytes: 40 });
        const image = await runtime.call('browser_screenshot', {}, { sessionId: 'a' });
        expect(image.contentBlocks).toEqual([{ type: 'image', mimeType: 'image/png', data: 'AQID' }]);
        await runtime.close?.();
    });

    it('rejects oversized screenshot output and bounds live session count', async () => {
        const f = fixture(), runtime = browserToolRuntime({ browser: f.browser, maxScreenshotBytes: 2, maxSessions: 1 });
        expect((await runtime.call('browser_screenshot', {}, { sessionId: 'a' })).ok).toBe(false);
        expect((await runtime.call('browser_snapshot', {}, { sessionId: 'b' })).content).toContain('capacity');
        await runtime.closeSession('a');
        expect((await runtime.call('browser_snapshot', {}, { sessionId: 'b' })).ok).toBe(true);
        await runtime.close?.();
    });

    it('closes the context on cancellation and quarantines uncertain effects', async () => {
        const f = fixture(), runtime = browserToolRuntime({ browser: async () => f.browser });
        await runtime.call('browser_snapshot', {}, { sessionId: 'a' });
        let started!: () => void;
        const ready = new Promise<void>(resolve => { started = resolve; });
        f.pages[0].goto = async () => { started(); return new Promise(() => {}); };
        const controller = new AbortController();
        const pending = runtime.call('browser_navigate', { url: 'https://a.test' }, { sessionId: 'a', signal: controller.signal });
        await ready;
        expect((await runtime.call('browser_snapshot', {}, { sessionId: 'a' })).content).toContain('already running');
        controller.abort();
        expect((await pending).errorKind).toBe('unknown');
        expect(f.contexts[0].close).toHaveBeenCalledOnce();
        expect((await runtime.call('browser_snapshot', {}, { sessionId: 'a' })).errorKind).toBe('unknown');
        await runtime.close?.();
        await runtime.close?.();
        expect(f.browser.close).toHaveBeenCalledOnce();
    });


    it('retains cleanup failures for shutdown instead of losing borrowed contexts', async () => {
        const f = fixture(), runtime = browserToolRuntime({ browser: f.browser });
        await runtime.call('browser_snapshot', {}, { sessionId: 'a' });
        f.pages[0].goto = async () => { throw new Error('effect outcome lost'); };
        f.contexts[0].close = vi.fn(async () => { throw new Error('cleanup failed'); });
        expect((await runtime.call('browser_navigate', { url: 'https://a.test' }, { sessionId: 'a' })).errorKind).toBe('unknown');
        await expect(runtime.close!()).rejects.toThrow('Browser cleanup failed');
    });

    it('closes contexts acquired after cancellation without running page actions', async () => {
        const f = fixture();
        let release!: (context: BrowserContext) => void;
        const delayed = new Promise<BrowserContext>(resolve => { release = resolve; });
        f.browser.newContext = vi.fn(() => delayed);
        const runtime = browserToolRuntime({ browser: f.browser });
        const controller = new AbortController();
        const pending = runtime.call('browser_snapshot', {}, { sessionId: 'a', signal: controller.signal });
        await vi.waitFor(() => expect(f.browser.newContext).toHaveBeenCalledOnce());
        controller.abort();
        expect((await pending).errorKind).toBe('cancelled');
        let closed = false;
        const closing = runtime.close!().then(() => { closed = true; });
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(closed).toBe(false);
        const context = { newPage: vi.fn(), close: vi.fn(async () => {}) };
        release(context);
        await vi.waitFor(() => expect(context.close).toHaveBeenCalledOnce());
        expect(context.newPage).not.toHaveBeenCalled();
        await closing;
        expect(closed).toBe(true);
    });
});
