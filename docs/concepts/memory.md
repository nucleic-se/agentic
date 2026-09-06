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

`InMemoryStore` lasts for the life of this process. Supply a durable `IMemoryStore`
adapter when memory must survive restarts.

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
