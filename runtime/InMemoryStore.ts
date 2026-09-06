/**
 * In-memory implementation of IMemoryStore.
 *
 * Suitable for testing and lightweight use. No external dependencies.
 * TTL eviction runs lazily on write() or explicitly via evictExpired().
 *
 * @module runtime
 */

import type { IMemoryStore, MemoryItem, MemoryQuery } from '../contracts/IMemory.js';
import { randomUUID } from 'node:crypto';
import { estimateTokens } from '../utils.js';

export class InMemoryStore implements IMemoryStore {
    private readonly items = new Map<string, MemoryItem>();

    async get(id: string): Promise<MemoryItem | undefined> {
        const item = this.items.get(id);
        if (!item) return undefined;
        if (this.isExpired(item, Date.now())) {
            this.items.delete(id);
            return undefined;
        }
        return structuredClone(item);
    }

    async query(query: MemoryQuery): Promise<MemoryItem[]> {
        if (!Number.isSafeInteger(query.limit) || query.limit < 0) throw new RangeError('Memory limit must be a non-negative safe integer');
        if (query.tokenBudget !== undefined && (!Number.isSafeInteger(query.tokenBudget) || query.tokenBudget < 0)) throw new RangeError('Memory tokenBudget must be a non-negative safe integer');
        if (query.limit === 0 || query.tokenBudget === 0) return [];
        let results = Array.from(this.items.values());
        // This lightweight adapter provides lexical matching, not embedding similarity.
        const terms = query.text?.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean) ?? [];
        if (terms.length) results = results.filter(item => {
            const text = `${item.key} ${JSON.stringify(item.value)} ${item.tags.join(' ')}`.toLocaleLowerCase();
            return terms.every(term => text.includes(term));
        });

        // Filter by type
        if (query.types && query.types.length > 0) {
            const typeSet = new Set(query.types);
            results = results.filter(item => typeSet.has(item.type));
        }

        // Filter by tags (any match)
        if (query.tags && query.tags.length > 0) {
            const tagSet = new Set(query.tags);
            results = results.filter(item =>
                item.tags.some(tag => tagSet.has(tag)),
            );
        }

        // Filter expired items
        const now = Date.now();
        results = results.filter(item => !this.isExpired(item, now));

        // Sort by confidence desc, then recency desc
        results.sort((a, b) => {
            if (b.confidence !== a.confidence) return b.confidence - a.confidence;
            return b.updatedAt - a.updatedAt;
        });

        // Apply token budget if specified
        if (query.tokenBudget != null) {
            const budgeted: MemoryItem[] = [];
            let tokens = 0;
            for (const item of results) {
                const itemTokens = estimateTokens(JSON.stringify(item.value));
                if (tokens + itemTokens > query.tokenBudget) continue;
                budgeted.push(item);
                tokens += itemTokens;
                if (budgeted.length >= query.limit) break;
            }
            return structuredClone(budgeted);
        }

        return structuredClone(results.slice(0, query.limit));
    }

    async write(
        item: Omit<MemoryItem, 'id' | 'createdAt' | 'updatedAt' | 'version'>,
    ): Promise<MemoryItem> {
        // Lazy TTL eviction before writing, as documented.
        await this.evictExpired();
        const now = Date.now();
        const committed: MemoryItem = {
            ...structuredClone(item),
            id: randomUUID(),
            createdAt: now,
            updatedAt: now,
            version: 1,
        };
        this.items.set(committed.id, committed);
        return structuredClone(committed);
    }

    async update(
        id: string,
        patch: Partial<Pick<MemoryItem, 'value' | 'confidence' | 'tags' | 'ttlDays'>>,
    ): Promise<MemoryItem> {
        const existing = this.items.get(id);
        if (!existing) {
            throw new Error(`InMemoryStore: Item '${id}' not found.`);
        }

        const updated: MemoryItem = {
            ...existing,
            ...structuredClone(patch),
            updatedAt: Date.now(),
            version: existing.version + 1,
        };
        this.items.set(id, updated);
        return structuredClone(updated);
    }

    async delete(id: string): Promise<void> {
        this.items.delete(id);
    }

    async evictExpired(): Promise<number> {
        const now = Date.now();
        let count = 0;
        for (const [id, item] of this.items) {
            if (this.isExpired(item, now)) {
                this.items.delete(id);
                count++;
            }
        }
        return count;
    }

    private isExpired(item: MemoryItem, now: number): boolean {
        if (item.ttlDays == null) return false;
        const expiresAt = item.createdAt + item.ttlDays * 86_400_000;
        return now > expiresAt;
    }
}
