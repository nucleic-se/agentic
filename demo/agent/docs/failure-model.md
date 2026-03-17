# Failure Model

Every failure category in the agent has an explicit recovery policy. No generic
catch-and-continue, no silent swallowing, no "best effort" that means "unknown behaviour."

---

## The central invariants

No matter what fails, these are always true:

1. **`agent_end` always fires.** It is in `CodingAgent._run()` `finally` — never in a
   pipeline step, never conditional on success. The only exception is process death.

2. **Every turn for which `turn_start` was emitted gets a `TurnRecord`.** If the turn began
   in the state machine (`turn_start` fired), a `TurnRecord` is committed to the execution
   store regardless of outcome. The record carries the failure reason. Note: context assembly
   happens before `turn_start` is emitted — a `context_error` therefore never violates this
   invariant because no turn has yet started.

3. **Conversation is never partially appended mid-turn.** Appends happen atomically at
   reconcile. The transcript may represent a partially executed tool plan (on abort or
   steering interruption), but the append itself is always complete and consistent.

4. **The root span is always closed.** `ISpanTracer` spans are opened and closed in matching
   `try/finally` blocks. An unclosed span is a bug, not an expected state.

---

## Failure categories

### `llm_transport_error`

**Cause:** `provider.turn()` throws — network error, timeout, server unavailable, or any
exception before a response is received. An infrastructure failure, not a model failure.

**Recovery:** Terminal. The turn cannot proceed without a response. The agent transitions to
`failed`, emits `error`, and stops.

**Why not retry?** Retry logic belongs at the provider layer. The provider can implement
backoff internally. A second retry loop in the agent produces unpredictable behaviour when
both levels fire simultaneously.

**Turn record:** `outcome: 'failed'`, `failure.kind: 'llm_transport_error'`.

---

### `llm_protocol_error`

**Cause:** `provider.turn()` returns a response that cannot be parsed or violates the
`ILLMProvider` contract — malformed JSON, missing required fields, unexpected stop reason.
A model or provider contract violation, not a network failure.

**Recovery:** Terminal. Different debugging path from `llm_transport_error`: a transport
error suggests infra problems; a protocol error suggests a provider implementation bug or
model capability regression. Keeping them separate makes on-call triage faster.

**Turn record:** `outcome: 'failed'`, `failure.kind: 'llm_protocol_error'`.

---

### `tool_validation_error`

**Cause:** `ToolPolicy.evaluate()` returns `{ kind: 'deny' }` for a tool call.

**Recovery:** Non-terminal. The denied call gets a synthetic `ToolResultMessage` describing
the denial — same schema as a runtime error. The `ToolExecution` is logged as
`status: 'policy_denied'`. Execution **continues with the next planned call**.

**Why not abort the turn?** The model planned multiple calls; one being denied doesn't
invalidate the others. The model sees the denial and can adapt. Aborting on a single denial
would make the policy impractically strict. Policy working correctly is not an error.

**No `error` event.** Policy denial is not a failure condition.

**Turn record:** `ToolExecution.status: 'policy_denied'` in execution records.

---

### `tool_runtime_error`

**Cause:** `IToolRuntime.call()` returns `{ ok: false, content: '...' }`. The tool ran and
returned an error result.

**Recovery:** Non-terminal. The error content is passed back to the model as a
`ToolResultMessage` with `isError: true`. The loop continues. The model sees what went wrong
and decides whether to retry, try a different approach, or report to the user.

**Why pass errors to the model?** The model has context the runtime doesn't. It knows whether
"file not found" means "try a different path" or "this is a fatal blocker." Mechanical retry
from the runtime layer produces worse outcomes than letting the model reason about the failure.

**Agent does not retry tools automatically.** Tools may implement internal retry; if so,
retries must be idempotent — the agent may call the same tool twice across turns.

**Turn record:** `ToolExecution.status: 'runtime_failure'`, `result.ok: false`.

---

### `tool_timeout`

**Cause:** A tool does not return within its `timeoutMs` budget. Distinct from
`tool_runtime_error` — the tool did not return at all, not that it returned an error.

**Recovery:** Non-terminal (treated as a runtime failure for the conversation, but marked
distinctly in execution records). The tool execution is cancelled, a synthetic
`ToolResultMessage` with `isError: true` and a timeout message is appended. Execution
continues for remaining planned calls.

**Why distinct from `tool_runtime_error`?** Timeout vs. error have different debugging
implications. A timeout suggests the tool is hanging or the system is overloaded; a runtime
error suggests the tool's logic failed. Debugging paths differ.

**Turn record:** `ToolExecution.status: 'timeout'`.

---

### `max_turns_exceeded`

**Cause:** The turn counter reaches `config.maxTurns` (default: 20) without the model
reaching `end_turn`. A safety limit, not an error in the traditional sense.

**Recovery:** Terminal. An agent running indefinitely is either looping or working on a task
with no feasible completion. The agent emits `error` with `kind: 'max_turns_exceeded'` and
stops.

**Turn record:** Not appended. The guard fires between turns, before `turn_start` is emitted
for the would-be next turn. No turn has started in the state-machine sense, so no TurnRecord
is created. The previous turn's record has `outcome: 'answered'` (it completed normally).
An `error` event fires at the agent level, followed by `agent_end`.

---

### `max_tokens_stop`

**Cause:** `stopReason === 'max_tokens'` — the model's output was truncated at the token
limit.

**Recovery:** Terminal. A truncated response is not safe to act on. If the response contains
a partial tool-call list, executing it would run only some of what the model intended with no
record of the rest. The agent stops.

**This is one of the most commonly mishandled cases in agent systems.** Most implementations
try to execute partial tool plans or continue blindly. Truncated output is structurally
ambiguous — the only safe response is to stop.

**Prevention:** `ContextBroker` and `IPromptEngine` keep input within budget. Frequent
`max_tokens_stop` suggests the context budget is too large relative to the model's output
token limit, or the system prompt is oversized.

**Turn record:** `outcome: 'partial'`, `failure.kind: 'max_tokens_stop'`.

---

### `abort`

**Cause:** `AbortSignal` fires — user cancellation, request timeout, parent process shutdown.

**Recovery:** Terminal — immediately. The kernel checks the signal before each tool
execution. Remaining planned calls are marked `status: 'cancelled'`.

The plan-as-history model applies: the full `AssistantMessage` (all planned calls intact)
is appended to conversation. Synthetic `ToolResultMessage`s (`status='cancelled'`) are
appended for calls that did not run — this is required by the LLM protocol. Every tool_use
in an `AssistantMessage` must have a corresponding result; an unanswered call is invalid
conversation state. The `TurnRecord` records which results are real vs. synthetic via
`ToolExecution.status`. The conversation append is atomic — never partial.

**Turn record:** `outcome: 'aborted'`, `interrupted.reason: 'abort'`.

---

### `context_error`

**Cause:** `ContextBroker.assemble()` throws before the turn begins.

**Recovery:** Terminal. There is no general fallback. A fallback to raw messages is unsafe
in the general case — in a long session it would overflow the model's context window,
replacing one failure with a different, harder-to-diagnose one. Therefore no fallback is
attempted.

**Invariant note:** Context assembly runs in `CodingAgent` before `runKernel()` is called.
`turn_start` is emitted inside `runKernel()`. Therefore a `context_error` happens before
any turn has started in the state machine sense — invariant 2 is not violated. No `TurnRecord`
is appended because no turn began.

**Turn record:** Not appended. An `error` event is emitted.

---

### `memory_error`

**Cause:** `FactStore` read or write fails.

**Recovery:** Degraded — the turn continues without memory. Memory is additive enrichment,
not load-bearing infrastructure. A turn that can't read facts still produces a correct
response from conversation and tool results. A turn that can't write facts loses a potential
update — acceptable.

**Why not terminal?** Aborting a long session because of a transient scratchpad write
failure wastes all prior work. The cost of continuing without memory is lower than the cost
of losing the session.

**Span:** Soft error recorded in span metadata. No `error` event emitted.

---

### `unknown_error`

**Cause:** An unrecognised exception escapes the kernel — something that doesn't map to any
category above.

**Recovery:** Terminal. The agent does not silently swallow unexpected errors. All invariants
are preserved (the `try/finally` structure guarantees this): `agent_end` fires, the root span
closes, and if a turn had started, a `TurnRecord` is committed with `outcome: 'failed'` and
`failure.kind: 'unknown_error'`. The full stack trace is preserved in `failure.message`.

**Why have this?** A complete failure taxonomy can't anticipate every future failure mode.
`unknown_error` is the gap-closer — it ensures the invariants hold even when a new failure
path is discovered in production. On investigation, `unknown_error` entries should be
promoted to a named category.

**Turn record:** `outcome: 'failed'`, `failure.kind: 'unknown_error'`.

---

## Steering interruption

Steering is not a failure — it is intentional runtime intervention. When
`getSteeringMessages` returns messages mid-execution:

1. Remaining planned calls are marked `status: 'skipped'`
2. `AssistantMessage` + `ToolResultMessage`s for **all** planned calls appended atomically
   — real results for completed calls, synthetic results for skipped calls (protocol requires
   a result for every tool_use in the `AssistantMessage`)
3. The interrupted turn is committed (TurnRecord, `outcome: 'interrupted'`) before the loop restarts
4. Steering messages are appended to conversation
4. Loop restarts from Step 1 (deliberate) with new context
5. `TurnRecord` records `outcome: 'interrupted'`, `interrupted: { plannedCalls,
   executedCalls, reason: 'steering' }`

`'interrupted'` is a distinct outcome — it is not `'partial'` (which is reserved for
`max_tokens_stop`) and not `'aborted'` (which is reserved for `AbortSignal`). Interrupted
means: a turn ran, was intentionally cut short, and the session continues.

---

## Error event semantics

`error` events are emitted when the agent cannot continue:

| Category | `error` event? |
|---|---|
| `llm_transport_error` | Yes |
| `llm_protocol_error` | Yes |
| `max_turns_exceeded` | Yes |
| `max_tokens_stop` | Yes |
| `abort` | Yes |
| `context_error` | Yes |
| `unknown_error` | Yes |
| `tool_validation_error` | **No** — policy working correctly |
| `tool_runtime_error` | **No** — model handles the error |
| `tool_timeout` | **No** — treated as runtime failure, model handles |
| `memory_error` | **No** — degraded, session continues |

- **`error` event** → agent stopped; caller must decide what to do
- **No `error` event** → agent continued; operational detail is in `TurnRecord` if needed

This makes `error` a reliable "agent stopped" signal for UI layers, without requiring callers
to parse every `TurnRecord` looking for failures.

---

## Reference: outcome → failure kind mapping

| `TurnOutcome` | `FailureKind` | Meaning |
|---|---|---|
| `'answered'` | — | Turn completed normally |
| `'partial'` | `'max_tokens_stop'` | Output truncated; stopped safely |
| `'failed'` | `'llm_transport_error'` | Infrastructure failure |
| `'failed'` | `'llm_protocol_error'` | Provider contract violation |
| `'failed'` | `'unknown_error'` | Unexpected exception |
| `'aborted'` | `'abort'` | AbortSignal fired; synthetic results for all unrun calls |
| `'interrupted'` | — | Steering interruption; session continues; synthetic results for skipped calls |

**Agent-level errors (no `TurnOutcome` — no TurnRecord created):**

| `FailureKind` | When it fires | Meaning |
|---|---|---|
| `'max_turns_exceeded'` | Guard between turns (before next `turn_start`) | Session hit safety limit |
| `'context_error'` | Before `turn_start` (assembly failure) | Context could not be assembled |

Both produce an `error` event followed by `agent_end`. Because `turn_start` was never emitted,
the TurnRecord invariant is not violated — there is simply no record to commit.
