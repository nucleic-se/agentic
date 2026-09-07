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

## Durable memory

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

## Reference harness recall

Start the demo with `--memory` to add `memory_search`, `memory_read` and
`memory_save`. Embedded compositions can set `memoryDatabase` on the default
agent options. Use a separate data directory per workspace; reopening a note
database under another workspace is rejected. The default tool set stays small
when this option is absent.

Notes are explicit writes, subject to the host's mutation policy. The shared
`memoryToolRuntime` requires a source reader and a versioned store. Tool execution
passes an opaque, host-owned `sessionId` separately from model arguments. A write
names a tool call in that session; the host resolves its durable receipt and
captures an exact, bounded text excerpt. Missing or ambiguous references fail.
The note retains source identity, capture time, error status, offset and original
text length. Captured evidence survives restart even if the original file changes.
The shared context renderer exposes receipt IDs as data when recall is enabled;
their text participates in context budgeting. Stored receipts remain unchanged.

Search returns at most five notes within 6000 characters. Reading a revision
returns its historical note and captured excerpt. Corrections require the current
version and new source evidence; older revisions remain inspectable. Notes are
fallible historical observations, never project instructions or proof of current
conditions. There is no automatic note injection or semantic retrieval.
To inspect beyond the excerpt, call `memory_read` with the note's `id`, `version`
and `sourceOffset: 0`. Continue with `nextOffset` until `eof` is true. Each page
contains at most 4000 UTF-16 code units from the original tool receipt. The host
loads that receipt from its archive; it never reruns the tool. The shared runtime
checks its reference and SHA-256 fingerprint, including the error status, against
the saved note before returning source text. This recovers a recorded tool result,
which may itself have been only one page of a file.

Source paging requires the original host archive. If it is missing or changed,
the tool reports the problem; the captured excerpt remains readable without
`sourceOffset`. Earlier notes without a fingerprint also retain their excerpts.
A note can contain an unsupported model inference even when its source is
authentic. Inspect the supporting text rather than treating note authorship as
proof. Embedded source readers accept either a host session/call query for capture
or an opaque stored reference for subsequent retrieval.

## Pattern: agent with working memory

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
