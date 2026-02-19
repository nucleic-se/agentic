/**
 * Memory system contracts.
 *
 * Four memory types (working, episodic, semantic, procedural) with
 * TTL, confidence, provenance, and versioning. The LLM proposes
 * writes; the orchestrator validates and commits.
 *
 * @module contracts
 */

// ── Types ──────────────────────────────────────────────────────

export type MemoryType = 'working' | 'episodic' | 'semantic' | 'procedural';

// ── Item ───────────────────────────────────────────────────────

export interface MemoryItem {
    readonly id: string;
    readonly type: MemoryType;
    readonly key: string;
    readonly value: unknown;
    readonly createdAt: number;      // ms epoch
    readonly updatedAt: number;      // ms epoch
    readonly ttlDays?: number;       // undefined = no expiry
    readonly confidence: number;     // 0.0–1.0
    readonly source: string;         // who wrote this (tool name, user, agent id)
    readonly tags: string[];
    readonly version: number;        // bumped on every update
}

// ── Query ──────────────────────────────────────────────────────

export interface MemoryQuery {
    /** Natural language or embedding query for relevance ranking. */
    text?: string;
    /** Filter by memory type. */
    types?: MemoryType[];
    /** Filter by tags. */
    tags?: string[];
    /** Maximum items to return. */
    limit: number;
    /** Maximum tokens the result set may consume (for prompt budget awareness). */
    tokenBudget?: number;
}

// ── Store ──────────────────────────────────────────────────────

export interface IMemoryStore {
    /** Get a single memory item by ID. */
    get(id: string): Promise<MemoryItem | undefined>;

    /** Query memory items with filtering and ranking. */
    query(query: MemoryQuery): Promise<MemoryItem[]>;

    /** Write a new memory item. Returns the committed item with ID and timestamps. */
    write(item: Omit<MemoryItem, 'id' | 'createdAt' | 'updatedAt' | 'version'>): Promise<MemoryItem>;

    /** Update an existing memory item. Returns the updated item with bumped version. */
    update(id: string, patch: Partial<Pick<MemoryItem, 'value' | 'confidence' | 'tags' | 'ttlDays'>>): Promise<MemoryItem>;

    /** Delete a memory item by ID. */
    delete(id: string): Promise<void>;

    /** Remove all items past their TTL. Returns count of evicted items. */
    evictExpired(): Promise<number>;
}

// ── Write Validation ───────────────────────────────────────────

/**
 * Validates and governs proposed memory writes.
 * The LLM proposes; the validator disposes.
 */
export interface IMemoryWriteValidator {
    validate(
        proposed: Omit<MemoryItem, 'id' | 'createdAt' | 'updatedAt' | 'version'>,
        store: IMemoryStore,
    ): Promise<'accept' | 'reject' | 'needs_confirmation'>;
}
