import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { IMemoryStore, MemoryItem, MemoryPatch, MemoryQuery } from '../contracts/IMemory.js';
import { estimateTokens } from '../utils.js';
import { openSqlite, type SqliteDatabase } from './sqlite.js';

type MemoryWrite = Omit<MemoryItem, 'id' | 'createdAt' | 'updatedAt' | 'version'>;
const expired = (item: MemoryItem, now: number) => item.ttlDays !== undefined && now > item.createdAt + item.ttlDays * 86400000;
const decode = (row?: Record<string, unknown>): MemoryItem | undefined => row ? JSON.parse(String(row.record)) : undefined;

/** Bounded workspace memory with lexical search and immutable revisions. */
export class SqliteMemoryStore implements IMemoryStore {
    private constructor(private db: SqliteDatabase, private maxItems: number, private maxVersions: number) {}

    static async open(path: string, scope: string, options: { maxItems?: number; maxVersions?: number } = {}): Promise<SqliteMemoryStore> {
        const maxItems = options.maxItems ?? 1000, maxVersions = options.maxVersions ?? 10000;
        if (!scope.trim() || scope.length > 2000) throw new Error('Memory requires a bounded workspace scope');
        if (![maxItems, maxVersions].every(value => Number.isSafeInteger(value) && value > 0)) throw new RangeError('Memory limits must be positive integers');
        if (path !== ':memory:') await mkdir(dirname(resolve(path)), { recursive: true });
        const db = await openSqlite(path);
        try {
            db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
            db.exec(`
                CREATE TABLE IF NOT EXISTS memory_scope (
                    id INTEGER PRIMARY KEY CHECK(id=1), scope TEXT NOT NULL, schema_version INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS memory_items (
                    id TEXT PRIMARY KEY, record TEXT NOT NULL, search TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS memory_versions (
                    id TEXT NOT NULL, version INTEGER NOT NULL, record TEXT NOT NULL, PRIMARY KEY(id, version)
                );
            `);
            db.prepare('INSERT OR IGNORE INTO memory_scope(id,scope,schema_version) VALUES(1,?,1)').run(scope);
            const metadata = db.prepare('SELECT scope,schema_version FROM memory_scope WHERE id=1').get()!;
            if (metadata.scope !== scope) throw new Error('Memory workspace scope mismatch');
            if (metadata.schema_version !== 1) throw new Error('Unsupported memory schema version');
            return new SqliteMemoryStore(db, maxItems, maxVersions);
        } catch (error) { db.close(); throw error; }
    }

    private transaction<T>(action: () => T): T {
        this.db.exec('BEGIN IMMEDIATE');
        try { const result = action(); this.db.exec('COMMIT'); return result; }
        catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }

    private save(item: MemoryItem) {
        if (!['working', 'episodic', 'semantic', 'procedural'].includes(item.type) || typeof item.key !== 'string' || !item.key.trim() || item.key.length > 200 ||
            typeof item.source !== 'string' || !item.source.trim() || item.source.length > 2000 || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1 ||
            !Array.isArray(item.tags) || item.tags.length > 32 || item.tags.some(tag => typeof tag !== 'string' || tag.length > 100) ||
            (item.ttlDays !== undefined && (!Number.isFinite(item.ttlDays) || item.ttlDays < 0))) throw new Error('Invalid memory item');
        const value = JSON.stringify(item.value);
        if (value === undefined || value.length > 8000) throw new Error('Memory values must be JSON and at most 8000 characters');
        if (!isDeepStrictEqual(item.value, JSON.parse(value))) throw new Error('Memory values must round-trip through JSON without loss');
        const record = JSON.stringify(item);
        if (Number(this.db.prepare('SELECT count(*) AS n FROM memory_versions').get()!.n) >= this.maxVersions) throw new Error('Memory revision capacity reached');
        this.db.prepare('INSERT INTO memory_versions(id,version,record) VALUES(?,?,?)').run(item.id, item.version, record);
        this.db.prepare('INSERT INTO memory_items(id,record,search) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record,search=excluded.search')
            .run(item.id, record, `${item.key} ${value} ${item.tags.join(' ')}`.toLocaleLowerCase());
    }

    async get(id: string): Promise<MemoryItem | undefined> {
        const item = decode(this.db.prepare('SELECT record FROM memory_items WHERE id=?').get(id));
        return item && !expired(item, Date.now()) ? item : undefined;
    }

    /** Explicit historical lookup includes expired revisions; inspect timestamps and TTL. */
    async getVersion(id: string, version: number): Promise<MemoryItem | undefined> {
        if (!Number.isSafeInteger(version) || version < 1) throw new RangeError('Invalid memory version');
        return decode(this.db.prepare('SELECT record FROM memory_versions WHERE id=? AND version=?').get(id, version));
    }

    async query(query: MemoryQuery): Promise<MemoryItem[]> {
        if (!Number.isSafeInteger(query.limit) || query.limit < 0 || (query.tokenBudget !== undefined && (!Number.isSafeInteger(query.tokenBudget) || query.tokenBudget < 0))) throw new RangeError('Invalid memory query budget');
        if (!query.limit || query.tokenBudget === 0) return [];
        const terms = query.text?.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean) ?? [];
        const where = terms.map(() => 'instr(search,?)>0').join(' AND ') || '1';
        const rows = this.db.prepare(`SELECT record FROM memory_items WHERE ${where} ORDER BY json_extract(record,'$.confidence') DESC,json_extract(record,'$.updatedAt') DESC,id`).all(...terms);
        const found: MemoryItem[] = []; let tokens = 0; const now = Date.now();
        for (const row of rows) {
            const item = decode(row)!;
            if (expired(item, now) || (query.types?.length && !query.types.includes(item.type)) || (query.tags?.length && !item.tags.some(tag => query.tags!.includes(tag)))) continue;
            const cost = estimateTokens(JSON.stringify(item.value));
            if (tokens + cost > (query.tokenBudget ?? Infinity)) continue;
            found.push(item); tokens += cost;
            if (found.length === query.limit) break;
        }
        return found;
    }

    async write(input: MemoryWrite): Promise<MemoryItem> {
        if (Object.keys(input).some(key => !['type', 'key', 'value', 'confidence', 'tags', 'ttlDays', 'source'].includes(key))) throw new Error('Invalid memory item field');
        const item = structuredClone(input);
        return this.transaction(() => {
            if (Number(this.db.prepare('SELECT count(*) AS n FROM memory_items').get()!.n) >= this.maxItems) throw new Error('Memory item capacity reached');
            const now = Date.now(), committed = { ...item, id: randomUUID(), createdAt: now, updatedAt: now, version: 1 };
            this.save(committed); return committed;
        });
    }

    async update(id: string, patch: MemoryPatch, expectedVersion?: number): Promise<MemoryItem> {
        if (Object.keys(patch).some(key => !['value', 'confidence', 'tags', 'ttlDays', 'source'].includes(key))) throw new Error('Invalid memory patch field');
        const changes = structuredClone(patch);
        return this.transaction(() => {
            const item = decode(this.db.prepare('SELECT record FROM memory_items WHERE id=?').get(id));
            if (!item || expired(item, Date.now())) throw new Error('Memory item not found');
            if (expectedVersion !== undefined && item.version !== expectedVersion) throw new Error('Memory version conflict');
            const updated = { ...item, ...changes, id: item.id, createdAt: item.createdAt, updatedAt: Date.now(), version: item.version + 1 };
            this.save(updated); return updated;
        });
    }

    async delete(id: string): Promise<void> {
        this.transaction(() => { this.db.prepare('DELETE FROM memory_items WHERE id=?').run(id); this.db.prepare('DELETE FROM memory_versions WHERE id=?').run(id); });
    }

    async evictExpired(): Promise<number> {
        return this.transaction(() => {
            const ids = this.db.prepare('SELECT record FROM memory_items').all().map(row => decode(row)!).filter(item => expired(item, Date.now())).map(item => item.id);
            for (const id of ids) this.db.prepare('DELETE FROM memory_items WHERE id=?').run(id);
            return ids.length;
        });
    }

    async close(): Promise<void> { this.db.close(); }
}
