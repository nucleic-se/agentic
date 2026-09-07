import { sessionSummary } from './session-summary.js';
import { openSqlite, type SqliteDatabase as Database } from '../sqlite.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { SessionEvent, SessionRecord, SessionStore, SessionPage, SessionSummary } from './types.js';

const copy = <T>(value: T): T => structuredClone(value);
function bounds(page?: SessionPage): { limit: number; offset: number } {
    if (!page) return { limit: -1, offset: 0 };
    if (!Number.isSafeInteger(page.limit) || page.limit < 0 || page.limit > 1000 || !Number.isSafeInteger(page.offset ?? 0) || (page.offset ?? 0) < 0) throw new RangeError('Invalid session page');
    return { limit: page.limit, offset: page.offset ?? 0 };
}
function eventLimit(after: number, limit?: number): number {
    if (!Number.isSafeInteger(after) || after < 0) throw new RangeError('Invalid event cursor');
    return bounds(limit === undefined ? undefined : { limit }).limit;
}
function validateCreate(record: SessionRecord): void {
    if (!record.id || record.revision !== 0) throw new Error('New sessions require an ID and revision 0');
}
function validateCommit(id: string, expected: number, record: SessionRecord, event: SessionEvent): void {
    if (!Number.isSafeInteger(expected) || expected < 0 || record.id !== id ||
        record.revision !== expected + 1 || event.sessionId !== id ||
        event.sequence !== record.revision || event.schemaVersion !== 1 || !event.id) {
        throw new Error('Invalid session commit identity, revision, sequence or schema');
    }
}

export class MemorySessionStore implements SessionStore {
    private records = new Map<string, SessionRecord>();
    private journal = new Map<string, SessionEvent[]>();
    private closed = false;
    private check(): void { if (this.closed) throw new Error('Session store is closed'); }
    async create(record: SessionRecord): Promise<void> {
        this.check(); validateCreate(record);
        if (this.records.has(record.id)) throw new Error('Session already exists');
        this.records.set(record.id, copy(record)); this.journal.set(record.id, []);
    }
    async get(id: string): Promise<SessionRecord | undefined> { this.check(); return copy(this.records.get(id)); }
    async list(page?: SessionPage): Promise<SessionSummary[]> { this.check(); const { limit, offset } = bounds(page); return copy([...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(offset, limit < 0 ? undefined : offset + limit).map(sessionSummary)); }
    async commit(id: string, expected: number, record: SessionRecord, event: SessionEvent): Promise<void> {
        this.check(); validateCommit(id, expected, record, event);
        if (this.records.get(id)?.revision !== expected) throw new Error('Session revision conflict');
        const events = this.journal.get(id)!;
        if (events.some(existing => existing.id === event.id)) throw new Error('Duplicate session event ID');
        const nextRecord = copy(record), nextEvent = copy(event);
        this.records.set(id, nextRecord); events.push(nextEvent);
    }
    async events(id: string, afterSequence = 0, limit?: number): Promise<SessionEvent[]> { this.check(); const count = eventLimit(afterSequence, limit); return copy((this.journal.get(id) ?? []).filter(event => event.sequence > afterSequence).slice(0, count < 0 ? undefined : count)); }
    async close(): Promise<void> { this.closed = true; }
}

/** Local-machine exclusive ownership. Ambiguous or foreign owners fail closed. */
async function acquire(path: string): Promise<() => Promise<void>> {
    const lock = `${path}.lock`;
    const token = randomUUID();
    const owner = { pid: process.pid, hostname: hostname(), token };
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let previous: typeof owner;
        try { previous = JSON.parse(await readFile(`${lock}/owner.json`, 'utf8')); }
        catch { throw new Error('Session store owner is unknown; inspect its lock before recovery'); }
        if (previous.hostname !== hostname() || !Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw new Error('Session store has a foreign or invalid owner');
        let alive = true;
        try { process.kill(previous.pid, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
        if (alive) throw new Error('Session store already has a live owner');
        // A claimant inside the stale directory prevents two recoverers removing a new lock.
        try { await mkdir(`${lock}/reclaim`); }
        catch { throw new Error('Session store lock recovery is already in progress'); }
        // The stale lock may have been replaced between inspection and claiming it.
        const claimed = JSON.parse(await readFile(`${lock}/owner.json`, 'utf8')) as typeof owner;
        if (claimed.token !== previous.token || claimed.pid !== previous.pid || claimed.hostname !== previous.hostname) {
            await rm(`${lock}/reclaim`, { recursive: true, force: true });
            throw new Error('Session store ownership changed during recovery');
        }
        const abandoned = `${lock}.stale-${token}`;
        await rename(lock, abandoned);
        await rm(abandoned, { recursive: true, force: true });
        await mkdir(lock, { mode: 0o700 });
    }
    try { await writeFile(`${lock}/owner.json`, JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); }
    catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
    return async () => {
        const current = JSON.parse(await readFile(`${lock}/owner.json`, 'utf8')) as typeof owner;
        if (current.token !== token) throw new Error('Session store ownership changed');
        await rm(lock, { recursive: true, force: true });
    };
}

/** Requires node:sqlite, or the optional better-sqlite3 package on older Node. */
export async function createSqliteSessionStore(path: string): Promise<SessionStore> {
    if (path === ':memory:') throw new Error('Use MemorySessionStore for ephemeral sessions');
    const absolute = resolve(path);
    await mkdir(dirname(absolute), { recursive: true });
    // Canonicalize existing files and parent paths to avoid aliases taking distinct locks.
    let canonical: string;
    try { canonical = await realpath(absolute); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        canonical = resolve(await realpath(dirname(absolute)), absolute.slice(dirname(absolute).length + 1));
    }
    const release = await acquire(canonical);
    let db: Database | undefined;
    try {
        db = await openSqlite(canonical);
        db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
        const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
        if (version !== 0 && version !== 1) throw new Error(`Unsupported session store schema version ${version}`);
        db.exec('BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (session_id TEXT NOT NULL, sequence INTEGER NOT NULL, id TEXT NOT NULL, event TEXT NOT NULL, PRIMARY KEY(session_id, sequence), UNIQUE(session_id, id)); PRAGMA user_version=1; COMMIT;');
        const database = db;
        let closed = false;
        const check = () => { if (closed) throw new Error('Session store is closed'); };
        return {
            async create(record) {
                check(); validateCreate(record);
                database.prepare('INSERT INTO sessions(id, revision, record) VALUES (?, ?, ?)').run(record.id, record.revision, JSON.stringify(record));
            },
            async get(id) {
                check(); const row = database.prepare('SELECT record FROM sessions WHERE id=?').get(id);
                return row ? JSON.parse(String(row.record)) as SessionRecord : undefined;
            },
            async list(page) {
                check(); const { limit, offset } = bounds(page);
                return database.prepare("SELECT json_object('id', id, 'revision', revision, 'title', json_extract(record, '$.title'), 'createdAt', json_extract(record, '$.createdAt'), 'updatedAt', json_extract(record, '$.updatedAt'), 'status', json_extract(record, '$.status')) AS summary FROM sessions ORDER BY json_extract(record, '$.updatedAt') DESC, id ASC LIMIT ? OFFSET ?").all(limit, offset).map(row => JSON.parse(String(row.summary)) as SessionSummary);
            },
            async commit(id, expected, record, event) {
                check(); validateCommit(id, expected, record, event);
                const recordJson = JSON.stringify(record), eventJson = JSON.stringify(event);
                database.exec('BEGIN IMMEDIATE');
                try {
                    const result = database.prepare('UPDATE sessions SET revision=?, record=? WHERE id=? AND revision=?').run(record.revision, recordJson, id, expected);
                    if (Number(result.changes) !== 1) throw new Error('Session revision conflict');
                    database.prepare('INSERT INTO events(session_id, sequence, id, event) VALUES (?, ?, ?, ?)').run(id, event.sequence, event.id, eventJson);
                    database.exec('COMMIT');
                } catch (error) { database.exec('ROLLBACK'); throw error; }
            },
            async events(id, afterSequence = 0, limit) {
                check(); const count = eventLimit(afterSequence, limit); return database.prepare('SELECT event FROM events WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(id, afterSequence, count).map(row => JSON.parse(String(row.event)) as SessionEvent);
            },
            async close() { if (!closed) { closed = true; try { database.close(); } finally { await release(); } } },
        };
    } catch (error) { try { db?.close(); } finally { await release(); } throw error; }
}
