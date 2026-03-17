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
  ttlMs: 60 * 60 * 1000,  // Expire in 1 hour (optional)
});

console.log(item.id);  // Auto-generated UUID
```

---

## Reading

```ts
// By ID
const item = await memory.get(item.id);

// By query
const results = await memory.query({
  types: ['working', 'semantic'],
  tags: ['sales'],
  limit: 10,
  tokenBudget: 4000,  // Stop when accumulated value length exceeds budget
});
```

### MemoryQuery fields

| Field | Type | Description |
|---|---|---|
| `types` | `MemoryType[]` | Filter by memory type |
| `tags` | `string[]` | All specified tags must be present |
| `keys` | `string[]` | Exact key matches |
| `limit` | `number` | Max items to return |
| `tokenBudget` | `number` | Stop accumulating once this rough token count is reached |
| `minConfidence` | `number` | Exclude items below this confidence score |

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
  expiresAt?: number;      // Unix ms, absent = no expiry
  provenance?: string;     // Where the knowledge came from
}
```

---

## Write validation

To govern LLM-proposed memory writes, implement `IMemoryWriteValidator`:

```ts
import type { IMemoryWriteValidator, MemoryItem, IMemoryStore } from '@nucleic-se/agentic/contracts';

class StrictValidator implements IMemoryWriteValidator {
  async validate(
    proposed: Partial<MemoryItem>,
    store: IMemoryStore
  ): Promise<'accept' | 'reject' | 'needs_confirmation'> {
    if (proposed.confidence! < 0.5) return 'reject';
    if (proposed.type === 'semantic') return 'needs_confirmation';
    return 'accept';
  }
}
```

---

## Pattern: agent with persistent working memory

```ts
import { InMemoryStore } from '@nucleic-se/agentic/runtime';
import { CallbackGraphNode } from '@nucleic-se/agentic/runtime';

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
