# Three Stores

Most agent implementations use a single `messages: Message[]` array as the source of truth.
That's the wrong abstraction. Three fundamentally different things are being tracked, and
collapsing them into one array creates a class of bugs that don't have clean fixes.

---

## The three stores

### 1. Conversation — protocol transcript

A faithful record of the user/assistant/tool-result exchange in protocol order. This is what
gets passed to `provider.turn()` on each call.

```ts
private conversation: Message[] = []
```

The conversation store records **protocol truth**, not interpreted completion truth. A
partially executed assistant tool plan still appears in full in the transcript. Policy-denied
calls produce synthetic `ToolResultMessage`s — these also appear in conversation. The
execution store is the authoritative record of which calls actually ran, which were denied,
and which were skipped.

Mutations: `prompt()` appends a `UserMessage`; the reconcile step (defined below) appends
the `AssistantMessage` and all `ToolResultMessage`s — real, synthetic denial, and synthetic
error — atomically. Conversation is **never mutated mid-turn**.

### 2. Execution — operational truth

One `TurnRecord` per turn, always. Contains:
- The full `TurnRequest` that was sent to the provider
- The full `AssistantMessage` that came back
- Every `ToolPlan` the model produced
- Every `ToolExecution` result — including `success`, `runtime_failure`, `policy_denied`,
  `cancelled`, and `skipped` calls
- Outcome, failure, interruption metadata
- Token usage, latency

```ts
private executions: TurnRecord[] = []
```

Mutations: one `TurnRecord` is appended at the **reconcile boundary** (defined below). Never
removed, never modified after write.

### 3. Context — model-facing projection

The assembled system string and the selection of history, summaries, facts, and tool results
that gets presented to the model this turn. Built fresh each turn by `ContextBroker` in
Phase C. In Phase A, this is just `config.systemPrompt`.

```ts
// Phase C: built by ContextBroker.assemble()
// Phase A: string | undefined from config
```

Context is **ephemeral** — it is not persisted between turns. It is a per-turn projection
assembled from durable artifacts: the conversation transcript, execution records, and
`TurnSummary`s. The summaries themselves are durable (see Phase C addition below), but
context is not the summaries — it is the assembled output produced from them.

---

## The reconcile boundary

"Reconcile" is used throughout the kernel pseudocode. This is its precise definition:

> **A turn is committed exactly once at reconcile, regardless of outcome.**

At reconcile, in this order:
1. Append `AssistantMessage` + all `ToolResultMessage`s to conversation (including
   synthetic messages for denied, cancelled, and skipped calls)
2. Append `TurnRecord` to execution store
3. Append `TurnSummary` to summaries, if Phase C is active and the turn qualifies

This commit is atomic from the perspective of the stores — no partial state is observable
between steps 1 and 3.

Two cases where reconcile does not run:
- **`context_error`**: `ContextBroker.assemble()` throws before `turn_start` is emitted.
  No turn has started in the state-machine sense, so nothing to reconcile.
- **`max_turns_exceeded`**: guard fires between turns, before the next `turn_start` is emitted.
  The previous turn already reconciled normally. An `error` event fires at the agent level.

---

## Canonical reconcile contract

Exact per-outcome specification of what is committed at reconcile:

| `TurnOutcome` | Conversation appends | Execution appends | Synthetic results required? |
|---|---|---|---|
| `answered` (no tools) | `AssistantMessage` | `TurnRecord` | No |
| `answered` (tools, all complete) | `AssistantMessage` + `ToolResultMessage`s | `TurnRecord` | No — all calls ran |
| `partial` | `AssistantMessage` (truncated) | `TurnRecord(failure.kind='max_tokens_stop')` | No — response cut before tool calls |
| `failed` | Nothing — no valid response | `TurnRecord(failure)` | No — no tool calls proposed |
| `aborted` | `AssistantMessage` + `ToolResultMessage`s for **all** planned calls | `TurnRecord(interrupted)` | **Yes** — `status='cancelled'` for every unrun call |
| `interrupted` | `AssistantMessage` + `ToolResultMessage`s for **all** planned calls + steering messages | `TurnRecord(interrupted)` | **Yes** — `status='skipped'` for every unrun call |

`max_turns_exceeded` and `context_error` are agent-level errors — no conversation or execution
appends occur, because no turn has started when these fire. They produce only an `error` event
and `agent_end`.

**The protocol completeness rule.** The LLM protocol requires a `ToolResultMessage` for every
`tool_use` in an `AssistantMessage`. This is not optional and not a design choice — it is a
protocol contract. Any call that did not run to completion (`cancelled`, `skipped`,
`policy_denied`) must receive a synthetic `ToolResultMessage`. Omitting it produces invalid
conversation state that the next LLM call will reject or misinterpret.

Standard synthetic content:
- `status='cancelled'`: `"Cancelled: AbortSignal fired before this call ran."`
- `status='skipped'`: `"Skipped: steering interrupted before this call ran."`
- `status='policy_denied'`: `"Denied by policy: <reason>."`

---

## Why three stores?

### The partial-turn problem

Suppose the agent is mid-turn — it has sent the LLM call, received a response with 3 tool
calls, and executed the first one. The `AbortSignal` fires.

With a single messages array: the `AssistantMessage` was not yet appended (mid-execution).
Append it now → conversation contains an unfinished turn. Don't append it → the session has
no record of what was planned. Either way is wrong.

With three stores, the answer follows from definitions:
- **Conversation** (protocol transcript): append the `AssistantMessage` with all 3 planned
  calls intact, then append `ToolResultMessage`s for **all 3 calls** — a real result for the
  one that ran, and synthetic results ("Cancelled: AbortSignal fired") for the two that didn't.
  This is required by the LLM protocol: every tool_use call in an `AssistantMessage` must
  have a corresponding `ToolResultMessage`. Omitting synthetic results leaves the conversation
  in an invalid state that the next LLM call will reject or misinterpret.
- **Execution** (operational truth): append a `TurnRecord` with `interrupted: { plannedCalls,
  executedCalls, reason: 'abort' }`. The full picture — which calls were real vs. synthetic —
  is here.
- **Context** (projection): irrelevant; it's ephemeral.

**Plan-as-history does not mean omitting synthetic results.** It means the `AssistantMessage`
is preserved intact (not stripped of unexecuted calls). Synthetic results are required by
protocol — this is not a design choice.

### The context divergence problem

After 20 turns, the `conversation` array has 80+ messages. The model's context window can't
fit all of them. The naive solution is to trim the oldest messages. But trimming the
conversation array means `getConversation()` returns something different from what was
actually said — callers who inspect conversation history see a lie.

With three stores:
- **Conversation** is never trimmed. It always contains the full faithful transcript.
- **Context** (managed by `ContextBroker`) is what gets assembled and sent to the model.
  The broker selects, scores, and trims — but only the model-facing projection. The
  conversation record is untouched.

### The replay problem

Debugging why an agent made a particular decision requires knowing *exactly* what was sent
to the model and *exactly* what came back. If the conversation array is used as both the
source of truth and a mutable working copy, these are no longer the same thing.

`TurnRecord.modelRequest` is immutable after write. It captures exactly what was sent —
the system string, the messages, the tools catalog, and configuration in effect at that turn.
Even if `ContextBroker` changes its selection strategy in a later phase, the replay record
from an earlier turn is unaffected.

---

## What you can derive from each store

| Question | Source |
|---|---|
| What did the user ask? | `conversation` |
| What did the model say? | `conversation` (AssistantMessage) |
| What tools did the model plan? | `execution[n].plan` |
| Which tools actually ran with success? | `execution[n].executions` where `status='success'` |
| Which calls were policy-denied? | `execution[n].executions` where `status='policy_denied'` |
| Why did the agent stop? | `execution[n].outcome` + `execution[n].failure` |
| Was this turn interrupted? | `execution[n].interrupted` |
| What exactly was sent to the model? | `execution[n].modelRequest` |
| How many tokens did this turn use? | `execution[n].tokenUsage` |
| What context did the model see? | `execution[n].contextUsed` (Phase C+) |

The conversation store answers user-facing questions. The execution store answers
agent-operational questions. They should not be collapsed.

---

## Policy-denied calls in conversation

When `ToolPolicy.evaluate()` returns `{ kind: 'deny' }`, the call is not executed. A
synthetic `ToolResultMessage` is generated — with `isError: true` and a reason string —
and this message **does appear in conversation** alongside real tool results.

This is correct. The model produced the tool call; the protocol requires a result for every
tool call in an `AssistantMessage`. A synthetic denial is the only way to produce a valid
protocol state. The model sees the denial and can adapt.

The distinction lives in execution: `ToolExecution.status: 'policy_denied'` makes it
unambiguous that this was not a runtime execution. Conversation records the protocol reality;
execution records the operational reality.

---

## IAgent surface

```ts
interface IAgent {
  getConversation():       readonly Message[]       // protocol transcript
  getExecutionHistory():   readonly TurnRecord[]    // operational truth
  getAllMessages():        readonly AgentMessage[]  // full application layer (Phase F)
}
```

A UI that needs to display the chat uses `getConversation()`. A debugger or replay tool uses
`getExecutionHistory()`.

---

## Phase C: summaries are inputs, not the context store

Phase C introduces `TurnSummary` — a persistent artifact generated post-turn, used by
`ContextBroker` to assemble future context for turns that have aged out of the raw tail.

```ts
// CodingAgent internal state (Phase C+)
private conversation:    Message[]      // protocol transcript — never trimmed
private executions:      TurnRecord[]   // operational truth — one per turn
private summaries:       Map<string, TurnSummary>  // broker inputs, keyed by turnId
```

Summaries are **not** the context store. Context is still ephemeral — assembled and discarded
each turn. Summaries are durable artifacts that the broker reads when building context. The
distinction:

- **Context store**: assembled per-turn, not persisted → ephemeral projection
- **Summaries**: generated post-turn, persisted → durable broker input

Each summary references a `turnId` and is associated with exactly one `TurnRecord`. Summaries
may be absent (not yet generated, or skipped because the turn was trivial), regenerated with
improved prompt quality, or versioned — none of these operations affect the execution store.
Positional indexing (`summaries[i] = executions[i]`) is fragile; link by `turnId`.
