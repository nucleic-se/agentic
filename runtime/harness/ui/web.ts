import { inspectHarness } from '../inspection.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Extension, SessionClient } from '../types.js';
import { WEB_PAGE, WEB_SCRIPT, WEB_STYLE } from './web-page.js';

export interface WebUiOptions { host?: string; port?: number; token: string }
const COOKIE = 'agentic_session';
const digest = (value: string) => createHash('sha256').update(value).digest();
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
    if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'Expected application/json');
    const chunks: Buffer[] = []; let size = 0;
    await new Promise<void>((resolve, reject) => {
        let rejected = false;
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 65_536) {
                if (!rejected) { rejected = true; chunks.length = 0; reject(new HttpError(413, 'Request body exceeds 64 KB')); }
            } else if (!rejected) chunks.push(chunk);
        });
        req.on('end', resolve);
        req.on('error', reject);
        req.on('aborted', () => reject(new HttpError(400, 'Request interrupted')));
    });
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Expected a JSON object');
    return value as Record<string, unknown>;
}
function required(value: unknown, name: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `Expected ${name}`);
    return value;
}
/** Local/LAN browser adapter; closing it detaches the UI without closing sessions. */
export async function startWebUi(client: SessionClient, options: WebUiOptions): Promise<{ url: string; close(): Promise<void> }> {
    if (typeof options.token !== 'string' || options.token.length < 24) throw new Error('Web UI token must contain at least 24 characters');
    const secret = digest(options.token);
    const sessions = new Map<string, number>();
    const streams = new Map<ServerResponse, string>();
    let actualPort = 0;
    const host = options.host ?? '127.0.0.1';
    const json = (res: ServerResponse, status: number, data: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data));
    };
    const server = createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
        try {
            const authority = req.headers.host;
            if (!authority || !/^(?:\[[a-fA-F0-9:]+\]|[a-zA-Z0-9.-]+)(?::\d+)?$/.test(authority)) throw new HttpError(400, 'Invalid Host');
            const url = new URL(req.url ?? '/', `http://${authority}`);
            if (url.host !== authority || (Number(url.port || 80) !== actualPort)) throw new HttpError(403, 'Invalid request authority');
            if (req.method === 'POST') {
                if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== `http://${authority}`)) throw new HttpError(403, 'Cross-origin request rejected');
            }
            if (req.method === 'GET' && ['/', '/app.js', '/app.css'].includes(url.pathname)) {
                const asset = url.pathname === '/' ? [WEB_PAGE, 'text/html'] : url.pathname === '/app.js' ? [WEB_SCRIPT, 'text/javascript'] : [WEB_STYLE, 'text/css'];
                res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8` }); res.end(asset[0]); return;
            }
            if (req.method === 'POST' && url.pathname === '/api/login') {
                const input = await body(req);
                if (typeof input.token !== 'string' || !timingSafeEqual(digest(input.token), secret)) throw new HttpError(401, 'Incorrect access token');
                const now = Date.now();
                for (const [key, expiry] of sessions) if (expiry <= now) sessions.delete(key);
                if (sessions.size >= 128) throw new HttpError(429, 'Too many browser sessions');
                const sessionToken = randomBytes(32).toString('hex');
                sessions.set(sessionToken, now + 12 * 60 * 60 * 1000);
                res.setHeader('Set-Cookie', `${COOKIE}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
                json(res, 200, { ok: true }); return;
            }
            const cookie = (req.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? '';
            let authenticated = false;
            for (const [key, expiry] of sessions) {
                if (timingSafeEqual(digest(cookie), digest(key)) && expiry > Date.now()) authenticated = true;
            }
            if (!authenticated) throw new HttpError(401, 'Sign in to continue');
            if (req.method === 'POST' && url.pathname === '/api/logout') {
                await body(req); sessions.delete(cookie);
                for (const [stream, key] of streams) if (key === cookie) { stream.end(); streams.delete(stream); }
                res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
                json(res, 200, { ok: true }); return;
            }
            if (req.method === 'GET' && url.pathname === '/api/stream') {
                if (streams.size >= 64) throw new HttpError(429, 'Too many event connections');
                res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
                res.write('event: ready\ndata: {}\n\n'); streams.set(res, cookie);
                res.on('close', () => streams.delete(res)); return;
            }
            if (req.method === 'GET' && url.pathname === '/api/composition') { json(res, 200, client.composition()); return; }
            if (url.pathname === '/api/sessions') {
                if (req.method === 'GET') {
                    const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined;
                    const offset = Number(url.searchParams.get('offset') ?? 0);
                    if ((limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0 || limit > 1000)) || !Number.isSafeInteger(offset) || offset < 0 || (offset && limit === undefined)) throw new HttpError(400, 'Invalid session page');
                    json(res, 200, await client.list(limit === undefined ? undefined : { limit, offset })); return;
                }
                if (req.method === 'POST') {
                    const input = await body(req);
                    if (input.title !== undefined && typeof input.title !== 'string') throw new HttpError(400, 'Invalid title');
                    json(res, 201, await client.create(input.title as string | undefined)); return;
                }
            }
            const match = /^\/api\/sessions\/([^/]+)(?:\/(inspect|events|submit|cancel|approve|fork|resume))?$/.exec(url.pathname);
            if (!match) throw new HttpError(404, 'Route not found');
            const id = decodeURIComponent(match[1]); const action = match[2];
            if (req.method === 'GET' && !action) { json(res, 200, await client.get(id)); return; }
            if (req.method === 'GET' && action === 'inspect') {
                json(res, 200, await inspectHarness(client, id, Number(url.searchParams.get('after') ?? 0))); return;
            }
            if (req.method === 'GET' && action === 'events') {
                const after = Number(url.searchParams.get('after') ?? 0);
                if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, 'Invalid event cursor');
                const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined;
                if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0 || limit > 1000)) throw new HttpError(400, 'Invalid event limit');
                json(res, 200, await (limit === undefined ? client.events(id, after) : client.events(id, after, limit))); return;
            }
            if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
            const input = await body(req);
            switch (action) {
                case 'submit':
                    if (input.mode !== undefined && input.mode !== 'steer' && input.mode !== 'enqueue') throw new HttpError(400, 'Invalid delivery mode');
                    await client.submit(id, required(input.content, 'content'), { commandId: required(input.commandId, 'commandId'), mode: input.mode as 'steer' | 'enqueue' | undefined });
                    json(res, 202, { ok: true }); return;
                case 'cancel': await client.cancel(id); break;
                case 'approve':
                    if (typeof input.allow !== 'boolean') throw new HttpError(400, 'Expected allow boolean');
                    await client.approve(id, required(input.approvalId, 'approvalId'), input.allow); break;
                case 'fork': json(res, 201, await client.fork(id)); return;
                case 'resume': await client.resume(id); break;
                default: throw new HttpError(404, 'Route not found');
            }
            json(res, 200, { ok: true });
        } catch (error) {
            if (!res.headersSent) json(res, error instanceof HttpError ? error.status : 400, { error: error instanceof Error ? error.message : 'Request failed' });
            else res.end();
        }
    });
    server.requestTimeout = 15_000; server.headersTimeout = 10_000;
    const unsubscribe = client.subscribe(update => {
        const data = `data: ${JSON.stringify(update)}\n\n`;
        for (const [stream, key] of streams) {
            if ((sessions.get(key) ?? 0) <= Date.now() || Buffer.byteLength(data) > 65_536 || !stream.write(data)) { stream.destroy(); streams.delete(stream); }
        }
    });
    const heartbeat = setInterval(() => {
        for (const [stream, key] of streams) if ((sessions.get(key) ?? 0) <= Date.now() || !stream.write(': heartbeat\n\n')) { stream.destroy(); streams.delete(stream); }
    }, 15_000); heartbeat.unref();
    try {
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, host, () => { server.off('error', reject); resolve(); }); });
    } catch (error) { clearInterval(heartbeat); unsubscribe(); throw error; }
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Web UI did not obtain a network address');
    actualPort = address.port;
    let closed = false;
    return {
        url: `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`,
        async close() {
            if (closed) return; closed = true; clearInterval(heartbeat); unsubscribe(); sessions.clear();
            for (const stream of streams.keys()) stream.destroy(); streams.clear();
            await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
        },
    };
}
export function webUiExtension(options: WebUiOptions): Extension {
    return { id: 'agentic.ui.web', version: '1.0.0', apiVersion: 1, async activate(client) { const ui = await startWebUi(client, options); return () => ui.close(); } };
}
