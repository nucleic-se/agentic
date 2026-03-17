# Memory — Facts and Scratchpad

`demo/agent` has two memory constructs, both backed by `IMemoryStore`:

- **Scratchpad** — session-scoped, mutable, single value. For active task state the model
  should carry forward (e.g. "current task: implement feature X").
- **Facts** — provenance-backed, typed entries. For durable knowledge extracted from tool
  results (file paths, config values, API endpoints, user preferences).

Both are managed by `FactStore` and queried by `ContextBroker` during context assembly.

---

## Fact types

| Type | What it holds | Example |
|------|--------------|---------|
| `semantic` | Codebase knowledge observed via tool | "Entry point is `src/index.ts`" |
| `episodic` | What happened in a specific turn | "Ran tests — 3 failures in `auth.test.ts`" |
| `procedural` | User preferences and corrections | "User prefers tabs, not spaces" |

---

## Write policy

The policy is enforced at write time in `FactStore.addFact()`, not inferred at read time.

### Confidence thresholds

- Reject any fact with `confidence < 0.4`
- `procedural` facts (user preferences) require `confidence >= 0.7`

### Grounding requirement

- `semantic` facts must be observed via a tool call — inferred codebase facts are rejected
- A fact is "observed" when its `source` includes a tool name

### Deduplication

- Key: `(type, key)` — same type and key is the same fact
- Update if `confidence >= current.confidence`, or values are meaningfully different
- Lower-confidence new entries for the same key are silently dropped

### Conflict resolution

- Conflicting `semantic` facts: new wins only if `confidence > existing.confidence`
- The superseded entry is preserved in span metadata, not silently overwritten

### Provenance format

```ts
source: "turn:{turnId}:{toolName}"    // observed via a tool call
source: "turn:{turnId}:inference"     // inferred — only allowed for episodic facts
```

---

## Fact extraction

`FactExtractor` runs after each qualifying turn using `router.select('fast')` +
`ILLMProvider.structured()`. It receives the full `TurnRecord` including tool results,
so extracted semantic facts can be grounded in observed data.

**Qualification gate** — skip extraction when the turn is clearly trivial:
- Assistant message contains fewer than 200 tokens, **and**
- Zero tool calls were made

**Tier routing heuristic:**

| What the model observes | Assigned tier |
|------------------------|--------------|
| "The user prefers X" / "User corrected me" | `procedural` |
| "I just did X and the result was Y" | `episodic` |
| "File X is the entry point" (observed via `fs_read`) | `semantic` |
| "Current task: implement Y" | scratchpad |

---

## Context assembly

`ContextBroker` queries `FactStore` each turn via `queryForContext(userInput, tokenBudget)`.
Facts are returned as scored `ContextCandidate[]` in the `semantic` lane with:

- Base authority: `0.75`
- Dynamic boost: `+0.15` if relevance > 0.7 (fact directly matches the current query)
- Minimum relevance: `0.8` when embedding similarity > 0.65 (Phase E+), bypassing keyword
  overlap

Scratchpad is rendered as a sticky `PromptSection` with authority `0.85`, boosted to `0.95`
when `mustInclude` is set (active task present).

---

## Limitations

- `InMemoryStore` is lost on process exit — facts and scratchpad do not survive restarts
- No cross-session memory without a persistent `IMemoryStore` implementation
