/**
 * Memory system contracts.
 *
 * Four memory types (working, episodic, semantic, procedural) with
 * TTL, confidence, provenance, and versioning. The LLM proposes
 * writes; the host runtime validates and commits.
 *
 * @module contracts
 */

// ── Types ──────────────────────────────────────────────────────

export type MemoryType = 'working' | 'episodic' | 'semantic' | 'procedural';

/**
 * Slot identifies where a structured fact lives.
 *
 * - `user`    — who the user is (global, shared across workspaces)
 * - `agent`   — lessons and conventions the agent has learned (global)
 * - `project` — workspace-specific facts (per-workspace)
 */
export type MemorySlot = 'user' | 'agent' | 'project';

/**
 * A structured fact stored in a slot.
 *
 * Facts are keyed by `(slot, key)` — unique constraint, upsert semantics.
 * `accessCount` and `lastAccessed` drive access-signal compaction.
 */
export interface MemoryFact {
    readonly id: string;
    readonly slot: MemorySlot;
    readonly key: string;           // short label, e.g. "Name", "Package manager"
    readonly value: string;         // one-sentence fact content
    readonly confidence: number;    // 0.0–1.0
    readonly createdAt: number;     // ms epoch
    readonly updatedAt: number;     // ms epoch
    readonly lastAccessed: number;  // ms epoch — updated on every query hit
    readonly accessCount: number;   // incremented on every query hit
}

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

// ── Slot-based fact store ───────────────────────────────────────

/**
 * Structured fact store — upsert by (slot, key), query by relevance, prune by access signal.
 *
 * Designed as an extension to IMemoryStore for the structured facts layer.
 * Implementations should use FTS for relevance ranking and update access
 * tracking on every query hit to enable principled compaction.
 */
export interface IFactStore {
    /**
     * Upsert a fact. Creates if `(slot, key)` is new; updates value and
     * confidence if it already exists. Returns the committed fact.
     */
    upsert(slot: MemorySlot, key: string, value: string, confidence?: number): Promise<MemoryFact>;

    /**
     * FTS-search facts in one or more slots by relevance to `text`.
     * Updates `accessCount` and `lastAccessed` on every returned record.
     */
    queryFacts(slots: MemorySlot[], text: string, limit: number): Promise<MemoryFact[]>;

    /**
     * Delete a single fact by `(slot, key)`. No-op if not found.
     */
    deleteFact(slot: MemorySlot, key: string): Promise<void>;

    /**
     * Prune least-used facts from a slot to stay under `cap`.
     *
     * Only removes records older than `minAgeDays` with `accessCount < minAccessCount`.
     * Returns the number of records deleted.
     */
    pruneSlot(slot: MemorySlot, cap: number, minAgeDays?: number, minAccessCount?: number): Promise<number>;

    /**
     * Return all facts in a slot, ordered by `lastAccessed DESC`.
     * Useful for building the flush prompt context.
     */
    listFacts(slot: MemorySlot): Promise<MemoryFact[]>;
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
