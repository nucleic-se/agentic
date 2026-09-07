# Memory

`IMemoryStore` provides a structured, queryable key-value store for agent memory. It supports four memory types with TTL, confidence scores, tags, and versioned updates.

---

## Memory types

| Type | Purpose |
|---|---|
| `working` | Short-term scratchpad for the current task or session |
| `episodic` | Records of past interactions and events |
| `semantic` | Facts and domain knowledge the agent has learned |
| `procedural` | Learned procedures and how-to patterns |

---

## InMemoryStore

The built-in implementation stores everything in process memory:

```ts
import { InMemoryStore } from '@nucleic-se/agentic/runtime';

const memory = new InMemoryStore();
```

---

## Writing

```ts
const item = await memory.write({
  type: 'working',
  key: 'current-task',
  value: 'Analyse Q3 sales data',
  confidence: 1.0,
  source: 'user',
  tags: ['task', 'sales'],
  ttlDays: 1 / 24,  // Expire in 1 hour from creation (optional)
});

console.log(item.id);  // Auto-generated UUID
```

---

## Reading

```ts
// By ID
const saved = await memory.get(item.id);

// By query
const results = await memory.query({
  types: ['working', 'semantic'],
  tags: ['sales'],
  limit: 10,
  tokenBudget: 4000,  // Estimated serialized-value tokens; oversized items are skipped
});
```

### MemoryQuery fields

| Field | Type | Description |
|---|---|---|
| `types` | `MemoryType[]` | Filter by memory type |
| `tags` | `string[]` | Match any specified tag in `InMemoryStore` |
| `text` | `string` | `InMemoryStore` matches all whitespace-separated terms, case-insensitively, across key, serialized value and tags |
| `limit` | `number` | Max items to return |
| `tokenBudget` | `number` | Maximum estimated serialized-value tokens; skip items that do not fit |

`limit` is required. `InMemoryStore` ranks matching items by confidence, then most
recent update. The store's token estimate is for selecting values; use context
composition to account for the final rendered prompt and the rest of the request.
Other adapters document their own text matching and ranking semantics.

---

## Updating

```ts
await memory.update(item.id, {
  value: 'Analyse Q3 and Q4 sales data',
  confidence: 0.9,
});
// version is incremented automatically
```

---

## Deleting

```ts
await memory.delete(item.id);

// Remove all expired items
const count = await memory.evictExpired();
console.log(`Evicted ${count} items`);
```

---

## MemoryItem shape

```ts
interface MemoryItem {
  id: string;
  type: MemoryType;
  key: string;
  value: unknown;          // Any serialisable value
  confidence: number;      // 0.0–1.0
  source: string;          // Who wrote this (e.g. 'user', 'agent', 'tool')
  tags: string[];
  version: number;         // Increments on each update
  createdAt: number;       // Unix ms
  updatedAt: number;
  ttlDays?: number;        // Days from createdAt; absent = no expiry
}
```

---

## Write validation

To govern LLM-proposed memory writes, implement `IMemoryWriteValidator`:

```ts
import type { IMemoryWriteValidator, MemoryItem, IMemoryStore } from '@nucleic-se/agentic/contracts';

class StrictValidator implements IMemoryWriteValidator {
  async validate(
    proposed: Omit<MemoryItem, 'id' | 'createdAt' | 'updatedAt' | 'version'>,
    store: IMemoryStore
  ): Promise<'accept' | 'reject' | 'needs_confirmation'> {
    if (proposed.confidence < 0.5) return 'reject';
    if (proposed.type === 'semantic') return 'needs_confirmation';
    return 'accept';
  }
}
```

---

## Pattern: agent with working memory

`InMemoryStore` lasts for the life of this process. `SqliteMemoryStore` implements
the same contract for notes that must survive restarts:

```ts
import { SqliteMemoryStore } from '@nucleic-se/agentic/runtime';

const memory = await SqliteMemoryStore.open('.data/memory.sqlite', workspaceId);
const note = await memory.write({
  type: 'procedural', key: 'verification', value: 'Run npm test',
  source: 'session:example/message:4', confidence: 1, tags: ['build'],
});
await memory.update(note.id, { value: 'Run npm run check' }, note.version);
const original = await memory.getVersion(note.id, 1);
await memory.close();
```

The host supplies a stable workspace identity and authentic source references.
The store checks identity on reopen; it does not resolve or authenticate source
strings. It is a persistence primitive, not automatic harness recall.

SQLite notes use the same all-term lexical matching and value-token budget as
`InMemoryStore`. Values must round-trip through JSON without loss and contain at
most 8000 serialized characters. Defaults cap active rows at 1000 and retained
revisions at 10000; `maxItems` and `maxVersions` configure these limits. Capacity
errors reject the entire write, including its revision. Updates can supply an
expected version to reject stale writes atomically across connections.

Expired notes are excluded from reads and search. `evictExpired()` removes their
active rows and frees item capacity, while `getVersion()` preserves access to
their recorded evidence. Explicit `delete()` removes both the item and its
history, freeing revision capacity. The host must manage retention; history is
never silently discarded. Token budgets cover candidate values only, so context
composition must still account for source labels and other rendered metadata.

SQLite uses Node's built-in driver when available, with optional `better-sqlite3`
as a fallback on older supported Node versions.

```ts
import { InMemoryStore } from '@nucleic-se/agentic/runtime';
import { CallbackGraphNode } from '@nucleic-se/agentic/runtime';

type MyState = { step: number; lastObservation: string; context: string };
const memory = new InMemoryStore();

// Save an observation after each LLM step
const saveObservation = new CallbackGraphNode<MyState>('save', async (state) => {
  await memory.write({
    type: 'episodic',
    key: `step-${state.step}`,
    value: state.lastObservation,
    confidence: 0.8,
    source: 'agent',
    tags: ['observation'],
  });
});

// Load relevant context before each LLM step
const loadContext = new CallbackGraphNode<MyState>('load', async (state) => {
  const items = await memory.query({ types: ['episodic', 'semantic'], limit: 5 });
  state.context = items.map(i => String(i.value)).join('\n');
});
```
