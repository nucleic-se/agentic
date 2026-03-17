# Context Broker

The ContextBroker answers the question: *given everything the agent knows, what should the
model see on this turn?*

Two responsibilities, kept deliberately separate:

1. **Selection** — normalise candidates, score them, apply tier rules, pick what fits
2. **Rendering** — build `PromptSection[]` and hand them to `IPromptEngine` for the hard
   token budget cut

`IPromptEngine` alone enforces the hard limit; the broker adds the intelligence to decide
*which* things are worth including before that limit is applied.

> Using `IPromptEngine` without a broker gives you budget enforcement. Using the broker
> without `IPromptEngine` gives you selection but no hard limit. Together they give you
> both, with clear responsibilities.

---

## Why not just pass all messages?

The naive approach (`provider.turn({ messages: this.conversation })`) breaks in two ways:

1. **Token overflow.** Long sessions overflow the model's context window. The common
   "compaction" fix — summarise the whole conversation and replace the array — is an
   emergency fallback that discards structure and is lossy by design.

2. **Undifferentiated soup.** Not all history has equal value. A fact found 20 turns ago via
   `fs_read` may be more relevant than a routine tool call from 2 turns ago. The model gets
   no signal about what matters most.

The broker replaces both anti-patterns.

---

## Candidate normalisation

Before scoring, every source of context is normalised into a `ContextCandidate`. This is the
only boundary where candidate generation happens — the scoring model operates on a clean,
uniform set.

```ts
export type CandidateLane =
  | 'sticky'        // system, tools — never dropped
  | 'must_include'  // near-certain inclusion; budget-conditional last resort only
  | 'working_state' // scratchpad, current task context
  | 'semantic'      // facts from FactStore
  | 'historical'    // TurnSummaries for older turns
  | 'structural'    // SessionFileTracker — working-set anchor
  | 'tail'          // last N raw conversation turns

export interface ContextCandidate {
  source:      ContextSource
  content:     string            // rendered text — normalised before scoring
  lane:        CandidateLane
  mustInclude: boolean           // true → must_include lane; competes only when budget is critical
  score:       ContextScore      // pre-computed; see scoring model below
  metadata: {
    turnId?:      string
    confidence?:  number         // for facts; absent = not applicable
    tokens?:      number         // estimated at candidate generation time
  }
}
```

All scoring and IPromptEngine encoding operates on `ContextCandidate[]`, not on raw source
objects. This makes candidate generation and selection independently testable.

---

## Scoring model

### Three axes

```ts
interface ContextScore {
  recency:   number   // 0–1: how recent, relative to the current turn
  relevance: number   // 0–1: how related to the current user input
  authority: number   // 0–1: how trustworthy or inherently important
}
```

**Recency** decays linearly from 1.0 (current turn) toward 0 (oldest turn in session).

**Relevance** is keyword-overlap in Phase C, embedding cosine-similarity in Phase E when
`ILLMProvider.embed()` is available. See relevance floor rules below.

**Authority** has a base value per source type, with dynamic boosting — see below.

### Composite scoring with soft floors

A purely multiplicative score (`authority × recency × relevance`) collapses when any single
axis is low — an old but critical fact with low keyword overlap scores near zero and gets
dropped. This is the wrong behaviour.

Instead, recency and relevance use a **soft floor of 0.5**:

```
score = authority × (0.5 + 0.5 × recency) × (0.5 + 0.5 × relevance)
```

This means:
- Minimum score for any candidate is `authority × 0.25` — a floor, not a zero
- High authority still dominates when recency and relevance are both high
- An old, not-yet-keyword-matching fact with authority 0.75 scores at least 0.19, keeping it
  competitive against low-authority recent noise
- The model of *"authority matters most, recency and relevance modulate"* is preserved

### Dynamic authority

Base authority values are not fully static — they are boosted at scoring time based on
contextual signals:

| Candidate type | Base authority | Dynamic boost |
|---|---|---|
| System prompt | 1.0 (sticky) | — |
| Tool catalog | 1.0 (sticky) | — |
| Trusted tool results | 0.9 | — |
| Standard tool results | 0.7 | — |
| Untrusted artifacts | 0.5 | — |
| Scratchpad | 0.85 | +0.1 if `mustInclude` (active task present) |
| Facts | 0.75 | +0.15 if relevance > 0.7 (query directly matches) |
| TurnSummary | 0.6 | +0.2 if `unresolvedItems.length > 0` |
| SessionFileTracker | 0.5 (sticky) | — |

Dynamic boosts are additive and capped at 1.0. They reflect the insight that a fact
directly matching the user query should outrank a recent but irrelevant tool call, even
though facts have lower base authority than trusted tool results.

### Relevance floors

Keyword overlap fails for paraphrasing, structural queries, and queries that don't repeat
recent wording. To prevent losing important state:

- **Summaries with `unresolvedItems.length > 0`** have a minimum relevance of **0.4** —
  unresolved work is always at least partially relevant regardless of keyword match.
- **Scratchpad** has a minimum relevance of **0.5** — active task state is always partially
  relevant to the current turn.
- **Facts** in Phase E that are semantically matched (embedding similarity > 0.65) get
  relevance = 0.8, bypassing keyword overlap entirely.

These floors are applied during candidate generation, before `IPromptEngine` sees scores.

### Encoding into `IPromptEngine`

`IPromptEngine.compose()` scores sections as `priority × weight × contextMultiplier`.
The three axes encode as:

```
IPromptSection.priority          = effectiveAuthority × 100
IPromptSection.weight            = 0.5 + 0.5 × recency     (soft-floor recency)
IPromptSection.contextMultiplier = 0.5 + 0.5 × relevance   (soft-floor relevance)
```

This encodes the full soft-floor scoring model into `IPromptEngine`'s native fields without
requiring any changes to the primitive.

---

## Candidate lanes and tier rules

Candidates are grouped into lanes. Intra-lane ranking happens before inter-lane balancing —
no lane floods the budget by accident.

### Tier 0 — Sticky (never dropped)

Budget-reserved before everything else:
- System section
- Tool catalog section
- `SessionFileTracker` section — see sticky justification below

### Tier 1 — Must-include-if-present

High-priority candidates that should survive all but critical budget pressure:
- **Scratchpad** — active task state (if non-empty)
- **Summaries with `unresolvedItems.length > 0`** — ongoing work the model must know about
- **Files actively in use** — files read or written in the last 2 turns

These candidates are not unconditionally sticky, but they enter the scored pool at the top
of their lane and are dropped last. If the budget is so tight that even these must go,
something structural is wrong (system prompt too large, session too long without reset).

### Tier 2 — Scored candidates by lane

After sticky and must-include candidates are placed, remaining budget `R` is distributed
across lanes using **soft caps**. These are defaults, not hard limits — underspend in one
lane flows to others.

| Lane | Content | Soft budget cap | Intra-lane ordering |
|---|---|---|---|
| `tail` | Last N raw conversation turns | 60% of R | Recency descending |
| `historical` | TurnSummaries for older turns | 25% of R | Composite score descending |
| `semantic` | Facts from FactStore | 15% of R | Composite score descending |
| `working_state` | Scratchpad (if not must-include) | Remaining | Single item |

**How soft caps work:** Each lane fills up to its cap from its top-ranked candidates. Unused
allocation (lane has fewer candidates than its cap allows) carries forward to the next lane in
priority order: tail → historical → semantic → working_state. IPromptEngine makes the final
hard cut on whatever sections remain.

Lane ordering prevents flooding unintentionally. Without caps, a session with many TurnSummaries
would consume the entire budget before a single fact or raw turn was included.

---

## Raw tail — high priority, not unconditional

The last N conversation turns are given high priority in the `tail` lane, not unconditional
sticky status. Default: N = 3 turns.

**When tail turns may be partially excluded:**
- Budget pressure is extreme (sticky + must-include sections leave very little room)
- Recent turns are low-relevance (user changed topic; old recent turns are noise)

In practice, tail turns have high recency (near 1.0) and usually medium-to-high relevance,
so they almost always survive scoring. The difference from sticky is that they participate
in the budget competition — in a critically constrained session, tail turns compete on merit
rather than consuming budget unconditionally.

The N=3 default is configurable via `AgentConfig.tailTurns`. Increasing it improves
coherence for long task sequences; decreasing it helps when turns are long and expensive.

---

## Selection flow

```
1. Sticky (tier 0) — placed, budget reserved:
     system section
     tool catalog section
     SessionFileTracker section

2. Collect and normalise candidates → ContextCandidate[]
     For each candidate: compute score, assign lane, set mustInclude flag

3. Must-include (tier 1) — placed if present:
     scratchpad                          (if non-empty)
     summaries with unresolvedItems      (sorted by recency)
     active-file sections                (files touched in last 2 turns)

4. Score remaining candidates with soft-floor model:
     effectiveAuthority = baseAuthority + dynamicBoost
     score = effectiveAuthority × (0.5 + 0.5×recency) × (0.5 + 0.5×relevance)
     Apply relevance floors for summaries and scratchpad

5. Intra-lane ranking → select top candidates per lane

6. Build PromptSection[] with encoded scores (soft-floor IPromptEngine encoding)

7. IPromptEngine.compose(sections, tokenBudget)
     — final hard budget cut
     — drops lowest-scoring sections first
     — sticky sections never dropped

8. Collect ContextCandidate[] selection metadata for TurnRecord.contextUsed
```

---

## Turn summaries — context hints, not ground truth

Summaries are generated eagerly after each turn and used as compressed history. They are
the primary mechanism for fitting long sessions into context.

```ts
interface TurnSummary {
  turnId:          string
  userIntent:      string       // what the user was asking for
  toolsUsed:       string[]
  filesRead:       string[]
  filesModified:   string[]
  keyFindings:     string[]     // grounded in tool outputs, not pure inference
  unresolvedItems: string[]     // what was left open
  outcome:         TurnOutcome
  tokenEstimate:   number
}
```

**Summaries are lossy, model-generated, and potentially wrong.** They are context hints —
not ground truth. The execution store (`TurnRecord`) is the authoritative record of what
happened. Summaries exist to help the model navigate long sessions; they are not a source
of truth for reasoning about past actions.

Implications:
- A summary should be treated with the same epistemic status as any LLM-generated text
- If a summary contradicts a tool result in the execution store, the execution store wins
- Summaries may be regenerated (e.g., with a better prompt) without changing execution history
- Consider tagging summaries with a `generatedAt` timestamp and a `modelTier` field for
  future invalidation or quality comparison

Why generating them eagerly is still right: summary quality is consistent across the session
(not degraded by context pressure), the model is never surprised mid-session, and raw
`TurnRecord`s always coexist in the execution store for authoritative lookup.

---

## Session file tracker — working-set anchor

`SessionFileTracker` accumulates all file paths read and written across the entire session.
It is sticky — budget-reserved, never dropped.

```
Files read this session:
  src/index.ts
  src/types.ts

Files modified this session:
  src/index.ts
  src/utils.ts
```

**Why sticky?** This section acts as a persistent working-set anchor. When all TurnSummaries
for a session are dropped under extreme budget pressure, the model still knows what it has
touched. Without this anchor, the model can lose track of its working set and re-read files
it already processed, or attempt to write files it hasn't read. At ~50 tokens it earns its
reserved budget unconditionally.

---

## `AssembledContext` — the model-facing boundary

```ts
interface AssembledContext {
  system:     string              // IPromptEngine output: facts, summaries, file tracker,
                                  //   base system prompt — all scored and budget-cut
  messages:   Message[]           // selected conversation tail; raw turns only;
                                  //   NOT the full raw conversation array
  selections: ContextCandidate[]  // for TurnRecord.contextUsed
  stats:      PromptComposeResult // included/excluded/totalTokens from IPromptEngine
}
```

`CodingAgent` passes **both** `context.system` and `context.messages` to `runKernel()`.
The kernel uses `context.messages` (not the raw `conversation` array) for the LLM call.
This is the seam that makes context selection real. Without `messages`, only `system`
changes between turns — summaries and selection decisions never reach the model.

**What goes where:**
- `system` ← IPromptEngine sections: summaries, facts, scratchpad, file tracker, base prompt.
  Structured context that benefits from scoring and hard budget enforcement.
- `messages` ← the selected tail of the raw conversation. The live conversational record.
  Typically the tail window computed by the broker from `AgentContextQuery.conversation`,
  possibly further trimmed if the tail exceeds budget after `system` is placed.

In Phase A (no broker), `CodingAgent` passes `{ system: config.systemPrompt, messages:
conversation }` directly — identical semantics, no broker overhead.

---

## Raw tail vs trust-tier-rendered results — one representation, not two

Tool results in `messages` and tool results in `system` are two different representations
of agent history, separated by the tail boundary. The same result **never appears in both**.

**The rule:** The tail boundary (N turns determined by `tailTurns`) is the hard dividing line.

| Turn position | How tool results appear |
|---|---|
| In tail (recent N turns) | Verbatim as `ToolResultMessage` objects in `messages` |
| Older than tail | Via `TurnSummary.keyFindings` / `toolsUsed` in `system` |

`ToolPromptRenderer` (trust-tier labeling) is used only for rendering results that go into
`system` — for example, excerpts from active files or content referenced in summaries. It is
NOT used to re-render results that are already in `messages` as raw conversation turns.

**Why this matters:** If a tool result were represented in both `messages` (raw) and `system`
(rendered summary), the model would see duplicated or conflicting information about the same
event. The tail boundary prevents this: the broker picks one side or the other, never both.

In practice: when a turn exits the tail (gets compressed to a summary), its `ToolResultMessage`
objects are no longer included in `messages`. The summary in `system` is the only representation
of that turn's tool activity the model sees.

---

## Debug traces

When `ISpanTracer` is present, `ContextBroker.assemble()` emits:

```ts
span 'context.assemble' metadata: {
  sectionsIncluded:   number,
  sectionsExcluded:   number,
  totalTokens:        number,
  topIncluded:  [{ source, lane, score, tokens }],
  topExcluded:  [{ source, lane, score, tokens, reason }],
}
```

Reason codes for exclusions:
- `budget_exceeded` — didn't fit after higher-priority sections placed
- `lower_score` — outranked in its lane
- `lane_budget_exhausted` — lane's allocation consumed by higher-ranked candidates
- `sticky_reserved_budget` — sticky + must-include sections consumed available budget

Two debugging questions remain independently answerable:
- *Did selection choose the wrong things?* → `topIncluded`/`topExcluded`, scores, lane
- *Did budget enforcement drop the right things?* → reason codes, token estimates

---

## Separation of concerns

| Concern | Owner |
|---|---|
| Normalising candidates from sources | `ContextBroker` → `ContextCandidate[]` |
| Scoring (3-axis, soft floors, dynamic authority) | `ContextBroker` |
| Lane grouping and intra-lane ranking | `ContextBroker` |
| Hard token budget enforcement | `IPromptEngine.compose()` |
| Rendering trust-tiered tool results | `ToolPromptRenderer` |
| Tracking file working set | `SessionFileTracker` |
| Recording selection decisions | `TurnRecord.contextUsed` |

---

## Relationship to `IPromptEngine`

`IPromptEngine` is the safety net. It enforces the hard limit. But it does not know:
- Which candidates have unresolved items that must survive budget pressure
- Which facts are directly query-matched vs. tangentially relevant
- That a scratchpad has higher authority than its base score suggests when a task is active
- The difference between a summary and a raw turn

The broker provides all those signals encoded into `IPromptEngine`'s native scoring fields.
`IPromptEngine` then applies its model to make the final cut, unmodified.

Using `IPromptEngine` without a broker gives you budget enforcement. Using the broker
without `IPromptEngine` gives you selection but no hard limit. Together they give you both,
with clear responsibilities at each layer.
