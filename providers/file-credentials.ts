import { constants } from 'node:fs';
import { mkdir, open, rename, rmdir, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';

const MAX_FILE_BYTES = 4 * 1024 * 1024;

function credential(value: unknown): Credential | undefined {
    if (value === undefined) return undefined;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const entry = value as Record<string, unknown>;
        if (entry.type === 'api_key' && (entry.key === undefined || typeof entry.key === 'string')) {
            return value as Credential;
        }
        if (entry.type === 'oauth' && typeof entry.access === 'string' && entry.access
            && typeof entry.refresh === 'string' && entry.refresh
            && typeof entry.expires === 'number' && Number.isFinite(entry.expires)) {
            return value as Credential;
        }
    }
    throw new Error('Invalid credential entry');
}

/** Explicit-path Pi-format JSON storage. Cooperating Agentic writers use <path>.lock directories.
 * Use a dedicated Agentic file; other applications may follow a different locking protocol.
 * A stale lock is never stolen. The caller must reconcile it after a crashed writer.
 * Unknown entries are preserved; reads never execute API-key commands.
 * Cancellation stops lock admission, but an admitted mutation drains and persists its result. */
export class FileCredentialStore implements CredentialStore {
    private readonly path: string;
    private readonly lockTimeoutMs: number;

    constructor(path: string, options: { lockTimeoutMs?: number } = {}) {
        if (!path.trim()) throw new Error('Credential file path is required');
        this.path = resolve(path);
        this.lockTimeoutMs = options.lockTimeoutMs ?? 10000;
        if (!Number.isSafeInteger(this.lockTimeoutMs) || this.lockTimeoutMs < 1 || this.lockTimeoutMs > 2147483647) {
            throw new RangeError('lockTimeoutMs must be a positive bounded integer');
        }
    }

    private async load(options?: AuthOperationOptions): Promise<Record<string, unknown>> {
        options?.signal?.throwIfAborted();
        let file;
        try {
            file = await open(this.path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
            throw error;
        }
        try {
            if (!(await file.stat()).isFile()) throw new Error('Credential path must be a regular file');
            const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
            let length = 0;
            while (length < buffer.length) {
                options?.signal?.throwIfAborted();
                const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
                if (!bytesRead) break;
                length += bytesRead;
            }
            options?.signal?.throwIfAborted();
            if (length > MAX_FILE_BYTES) throw new Error('Credential file exceeds 4 MiB');
            let parsed: unknown;
            try {
                parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
            } catch {
                throw new Error('Credential file must contain valid UTF-8 JSON');
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new Error('Credential file must contain a JSON object');
            }
            return parsed as Record<string, unknown>;
        } finally {
            await file.close();
        }
    }

    async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
        const entries = await this.load(options);
        return credential(Object.hasOwn(entries, providerId) ? entries[providerId] : undefined);
    }

    async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
        const entries = await this.load(options);
        return Object.entries(entries).flatMap(([providerId, value]) => {
            const type = value && typeof value === 'object' ? (value as { type?: unknown }).type : undefined;
            return type === 'oauth' || type === 'api_key' ? [{ providerId, type }] : [];
        });
    }

    private async locked<T>(action: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
        options?.signal?.throwIfAborted();
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const lockPath = `${this.path}.lock`;
        const deadline = performance.now() + this.lockTimeoutMs;
        while (true) {
            options?.signal?.throwIfAborted();
            try {
                await mkdir(lockPath, { mode: 0o700 });
                break;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                const remaining = deadline - performance.now();
                if (remaining <= 0) throw new Error('Credential file lock timed out; another writer or an unreconciled stale lock may exist. No lock was removed.');
                await delay(Math.min(25, remaining), undefined, { signal: options?.signal });
            }
        }
        try {
            options?.signal?.throwIfAborted();
            return await action();
        } finally {
            await rmdir(lockPath);
        }
    }

    private async save(entries: Record<string, unknown>): Promise<void> {
        const content = JSON.stringify(entries, null, 2) + '\n';
        if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('Credential file exceeds 4 MiB');
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        const file = await open(temporary, 'wx', 0o600);
        try {
            try {
                await file.writeFile(content, 'utf8');
                await file.sync();
            } finally {
                await file.close();
            }
            await rename(temporary, this.path);
        } finally {
            try { await unlink(temporary); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
    }

    modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
        return this.locked(async () => {
            const entries = await this.load(options);
            const current = credential(Object.hasOwn(entries, providerId) ? entries[providerId] : undefined);
            options?.signal?.throwIfAborted();
            const next = await fn(structuredClone(current));
            if (next === undefined) return current;
            credential(next);
            Object.defineProperty(entries, providerId, { value: next, enumerable: true, configurable: true, writable: true });
            await this.save(entries);
            return next;
        }, options);
    }

    async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
        await this.locked(async () => {
            const entries = await this.load(options);
            if (!Object.hasOwn(entries, providerId)) return;
            options?.signal?.throwIfAborted();
            delete entries[providerId];
            await this.save(entries);
        }, options);
    }
}
