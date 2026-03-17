# CodingAgent — Implementation Plan

A stateful coding agent built on `@nucleic-se/agentic` primitives.

This plan is a synthesis of two design perspectives:

- **Pi-influenced**: event-driven loop, hook surface, prompt budget assembly, trust tiers,
  pluggable tools — the best ideas from the Pi reference architecture
- **State-machine-first**: the agent's execution kernel is driven by explicit state transitions,
  not loop mechanics; three separate stores; tool planning and policy as first-class concerns;
  correctness before extensibility

The core philosophical question this plan answers is not *"how do we assemble a capable agent
from the right abstractions?"* but *"what are the minimum runtime truths we must preserve so
the agent stays correct under interruption, failure, and growth?"*

---

## Design Principles

1. **State is the source of truth.** The state machine defines what can happen next. The loop
   is just a driver.

2. **Three stores, not one history.** What the user and assistant said (conversation), what
   the agent actually did (execution), and what the model is allowed to see (context) are
   separate projections. They are not the same thing.

3. **Plan before executing.** Tool calls are a plan produced by the model. The runtime
   validates, executes, and reconciles the plan explicitly — it does not just fire calls
   and hope.

4. **Correctness before extensibility.** Memory, pipelines, hooks, and streaming come last.
   The execution kernel and policy layer must be solid before anything is layered on top.

5. **Failures are first-class.** Every failure category has an explicit recovery policy.
   Degraded execution is better than silent wrongness.

---

## Phase Overview

| Phase | Name | Goal | Depends on | Primitives introduced |
|---|---|---|---|---|
| A | **Execution kernel** | State machine, turn record, deliberate/plan/execute/reconcile | — | `ILLMProvider.turn()`, `IToolRuntime`, `IModelRouter` |
| B | **Policy & trust** | Formal tool policy, trust-tier enforcement, external artifacts | A | `IToolRegistry`, `ToolTrustTier` |
| C | **Context broker** | Selection + rendering + budget; turn summarisation | A, B | `IPromptEngine`, `IPromptContributor`, `ToolPromptRenderer` |
| D | **Observability** | Span tracing, turn replay, context decision traces | A | `ISpanTracer` |
| E | **Memory** | Scratchpad + facts store with provenance and write policy | A, B, C, D | `IMemoryStore`, `ILLMProvider.structured()` |
| F | **Extensions** | Hook surface, pipelines, streaming, pluggable operations | A–E | `ITickPipeline`, `ITickStep` |

---

## Failure Model

Defined here once. Every failure category has an explicit recovery policy.

| Category | Cause | Loop continues? | `TurnOutcome` | `error` event? | Span status |
|---|---|---|---|---|---|
| `llm_transport_error` | `provider.turn()` throws (infra/network) | No — terminal | `'failed'` | Yes | `error` |
| `llm_protocol_error` | Response unparsable / contract violation | No — terminal | `'failed'` | Yes | `error` |
| `tool_validation_error` | Policy denies a call | Yes — synthetic result, next call proceeds | (per-execution, not per-turn) | No | `ok` |
| `tool_runtime_error` | `tools.call()` returns `ok: false` | Yes — error result appended, continue | (per-execution) | No | `ok` |
| `tool_timeout` | Tool exceeded `timeoutMs` | Yes — treated as runtime failure | (per-execution) | No | `ok` |
| `max_tokens_stop` | `stopReason === 'max_tokens'` | No — terminal | `'partial'` | Yes | `error` |
| `abort` | `AbortSignal` fires | No — terminal | `'aborted'`¹ | Yes | `cancelled` |
| Steering interruption | `getSteeringMessages` returns mid-execution | Yes — loop restarts | `'interrupted'`¹ | No | `ok` |
| `max_turns_exceeded` | Guard fires between turns (before next `turn_start`) | No — terminal | No TurnRecord² | Yes | `error` |
| `context_error` | `ContextBroker.assemble()` fails before `turn_start` | No — terminal | No TurnRecord² | Yes | `error` |
| `memory_error` | `FactStore` read or write fails | No — degraded, continues | No TurnRecord impact | No | `ok` (soft span error) |
| `unknown_error` | Unrecognised exception escapes kernel | No — terminal | `'failed'` | Yes | `error` |

¹ `aborted` and `interrupted` both require synthetic `ToolResultMessage`s for every planned call
that did not run. This is a protocol requirement — every `tool_use` in an `AssistantMessage` must
have a corresponding result. See [three-stores.md — Canonical reconcile contract](docs/three-stores.md).

² `max_turns_exceeded` and `context_error` fire before `turn_start` is emitted; no turn has started
in the state-machine sense, so no TurnRecord is created and the TurnRecord invariant is not violated.

**Global invariants:**
- `agent_end` always fires — `finally` block in `CodingAgent._run()`, never in a pipeline step
- Every turn for which `turn_start` was emitted gets a `TurnRecord`, regardless of outcome
- Conversation is never partially appended mid-turn — appends are atomic at reconcile
- The root span is always closed with an appropriate status

---

## Cumulative `AgentConfig`

Lives in `demo/agent/config.ts` — not in `contracts/` because it references demo-layer
types (`ContextBroker`, `FactStore`, hook contexts). Full shape across phases:

```ts
// demo/agent/config.ts
interface AgentConfig {
  // ── Phase A — required ──────────────────────────────────────────────────────
  router: IModelRouter        // { select: () => provider } for single-provider setups
  tools:  IToolRuntime

  // ── Phase A — optional ──────────────────────────────────────────────────────
  systemPrompt?:        string
  maxTurns?:            number                     // default: 20
  getSteeringMessages?: () => Promise<Message[]>   // polled after each tool call
  getFollowUpMessages?: () => Promise<Message[]>   // polled after end_turn

  // ── Phase B ─────────────────────────────────────────────────────────────────
  policy?:   IToolPolicy      // from @nucleic-se/agentic/contracts; default: DefaultToolPolicy(registry)
  registry?: IToolRegistry    // required for DefaultToolPolicy trust-tier resolution

  // ── Phase C ─────────────────────────────────────────────────────────────────
  contextBroker?: ContextBroker   // default: DefaultContextBroker(promptEngine, tracer?)
  promptEngine?:  IPromptEngine   // used inside ContextBroker; absent = no budget trimming
  tokenBudget?:   number          // default: 28_000
  tailTurns?:     number          // raw conversation turns always in tail lane; default: 3

  // ── Phase D ─────────────────────────────────────────────────────────────────
  tracer?: ISpanTracer

  // ── Phase E ─────────────────────────────────────────────────────────────────
  factStore?: FactStore           // provides scratchpad + facts retrieval

  // ── Phase F ─────────────────────────────────────────────────────────────────
  beforeToolCall?:      (ctx: BeforeToolCallContext)  => Promise<BeforeToolCallResult>
  afterToolCall?:       (ctx: AfterToolCallContext)   => Promise<AfterToolCallResult | void>
  transformMessages?:   (messages: Message[])         => Promise<Message[]>
  onBeforeLlmCall?:     (messages: Message[])         => Promise<Message[]>
  steeringMode?:        'all' | 'one-at-a-time'       // default: 'all'
  followUpMode?:        'all' | 'one-at-a-time'       // default: 'one-at-a-time'
}
```

---

# Phase A — Execution Kernel

**Goal:** A correct, minimal agent. The state machine drives execution. The kernel function
is a pure deliberate → plan → execute → reconcile loop with explicit turn records.
No memory, no pipelines, no hooks beyond steering and follow-up.

## What works after Phase A

- `agent.prompt(input, sink?)` runs a full multi-turn tool-calling session
- `agent.continue(sink?)` resumes without a new user message
- State machine transitions are the authoritative record of what happened
- Every turn produces a `TurnRecord` — the canonical debug object
- Three stores: conversation (messages), execution (turn records), context (to be built in Phase C; Phase A uses raw messages)
- `getSteeringMessages` / `getFollowUpMessages` for real-time interaction
- Full failure taxonomy — every error category handled
- `agent_end` guaranteed in `finally`

## New files

```
contracts/agent.ts          Pure protocol types only — no demo/ imports.
                            AgentState, TurnRecord, ToolPlan, ToolExecution, Failure,
                            FailureKind, TurnOutcome, AgentEvent, AgentEventSink, IAgent.
demo/agent/config.ts        AgentConfig — references demo-layer types (ContextBroker,
                            ToolPolicy, FactStore, hook contexts). Lives in demo/ because
                            it depends on demo/ abstractions. Not in contracts/.
demo/agent/kernel.ts        Core deliberate/plan/execute/reconcile loop (pure function)
demo/agent/CodingAgent.ts   Stateful wrapper — owns the three stores
demo/agent/tools.ts         createCodingTools() factory
demo/agent/index.ts         Barrel + createCodingAgent()
```

**Import boundary rule:** `contracts/agent.ts` imports only from other `contracts/` files.
`demo/agent/config.ts` imports from both. Nothing in `contracts/` imports from `demo/`.

---

## Core types — `contracts/agent.ts` — Phase A

### State machine

The kernel's internal state. Transitions are explicit; the loop is just a driver.

```ts
export type AgentState =
  | { kind: 'idle' }
  | { kind: 'deliberating';  turnId: string }
  | { kind: 'planning';      turnId: string; response: AssistantMessage }
  | { kind: 'executing';     turnId: string; plan: ToolPlan[]; completed: ToolExecution[] }
  | { kind: 'reconciling';   turnId: string; plan: ToolPlan[]; executions: ToolExecution[] }
  | { kind: 'done' }
  | { kind: 'failed';        failure: Failure }
  | { kind: 'aborted' }
```

### Tool plan and execution

```ts
export interface ToolPlan {
  callId:    string
  name:      string
  input:     unknown
  // trustTier added in Phase B when registry is available
}

export type ToolExecutionStatus =
  | 'success'
  | 'runtime_failure'   // tools.call() returned ok: false
  | 'timeout'           // tool exceeded timeoutMs — did not return
  | 'policy_denied'     // Phase B — ToolPolicy denied
  | 'cancelled'         // AbortSignal fired mid-execution
  | 'skipped'           // steering interrupted before this call ran

export interface ToolExecution {
  callId:     string
  plan:       ToolPlan
  status:     ToolExecutionStatus
  result?:    ToolCallResult
  latencyMs?: number
  error?:     string
}
```

### Failure

```ts
export type FailureKind =
  | 'llm_transport_error'   // provider.turn() threw — infrastructure failure
  | 'llm_protocol_error'    // response unparsable / contract violation — model failure
  | 'tool_timeout'          // tool didn't return within timeoutMs
  | 'max_turns_exceeded'    // safety turn limit reached
  | 'max_tokens_stop'       // model output truncated
  | 'context_error'         // ContextBroker.assemble() threw before turn_start
  | 'abort'                 // AbortSignal fired
  | 'unknown_error'         // unrecognised exception; promotes to named category on investigation

export interface Failure {
  kind:    FailureKind
  message: string           // includes stack trace for unknown_error
}
```

### TurnRecord — the canonical debug object

```ts
export interface TurnRecord {
  turnId:       string
  userInput:    string | null          // null for continue()
  // Phase C populates contextUsed
  contextUsed?: ContextCandidate[]     // what was selected for this turn's model input
  modelRequest: TurnRequest            // exactly what was sent to the provider
  modelResponse: AssistantMessage      // exactly what came back
  plan:         ToolPlan[]             // all calls the model planned
  executions:   ToolExecution[]        // what actually ran (may be partial)
  outcome:      TurnOutcome
  failure?:     Failure
  interrupted?: {
    plannedCalls:  string[]            // all call IDs the model intended
    executedCalls: string[]            // those that actually ran
    reason:        'steering' | 'abort'
    // Note: policy denials (status='policy_denied') do NOT interrupt the turn —
    // they mark individual calls and execution continues for remaining calls.
  }
  durationMs:   number
  tokenUsage:   TokenUsage
}

export type TurnOutcome =
  | 'answered'     // completed normally (end_turn, stop_sequence, or all tools ran)
  | 'partial'      // max_tokens_stop; response truncated; agent stops safely
  | 'failed'       // llm_transport_error, llm_protocol_error, unknown_error
  | 'aborted'      // AbortSignal fired; synthetic results for all unrun calls
  | 'interrupted'  // steering interruption; session continues; synthetic results for skipped calls

// NOTE: 'terminated' is NOT a TurnOutcome. max_turns_exceeded fires at the loop guard
// between turns — no turn_start has been emitted, so no TurnRecord is created.
// The agent emits { type: 'error', failure: { kind: 'max_turns_exceeded' } } followed
// by agent_end, and stops. The last committed TurnRecord has outcome='answered'.
// Similarly, context_error fires before turn_start — no TurnRecord, only error + agent_end.
```

**Three stores, three identities:**

- **Conversation** — *protocol transcript*. What the user and assistant said, in protocol
  order, including partially executed tool plans and synthetic denial/error results. Never
  trimmed. Never mutated mid-turn.
- **Execution** — *operational truth*. One `TurnRecord` per turn: what the model planned,
  what actually ran, what was denied, why the turn ended.
- **Context** — *model-facing projection*. Assembled fresh each turn from durable artifacts;
  ephemeral between turns. Managed by `ContextBroker` in Phase C.

**Reconcile invariant:** a turn is committed exactly once, regardless of outcome. At reconcile:
conversation appends are made, the `TurnRecord` is committed, and (Phase C) the `TurnSummary`
is stored — all atomically. Projecting any one store from another introduces bugs.

---

## Events — `contracts/agent.ts` — Phase A (continued)

All types in this section live in the same `contracts/agent.ts` file as the state and turn
types above. The file has no imports from `demo/`.

```ts
import type { Message, AssistantMessage, IModelRouter } from './llm.js'
import type { IToolRuntime } from './tool-runtime.js'
// TurnRecord, Failure, ToolExecution defined earlier in this same file

// ── Events ─────────────────────────────────────────────────────────────────────

export type AgentEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end';      records: TurnRecord[] }
  | { type: 'turn_start';     turnId: string }
  | { type: 'turn_end';       record: TurnRecord }
  | { type: 'message_end';    message: AssistantMessage }
  | { type: 'tool_start';     turnId: string; callId: string; name: string; input: unknown }
  | { type: 'tool_end';       turnId: string; callId: string; name: string; execution: ToolExecution }
  | { type: 'error';          failure: Failure }

export type AgentEventSink = (event: AgentEvent) => void | Promise<void>

// ── Interface ──────────────────────────────────────────────────────────────────

export interface IAgent {
  prompt(input: string, sink?: AgentEventSink): Promise<TurnRecord[]>
  continue(sink?: AgentEventSink): Promise<TurnRecord[]>
  /** LLM-visible conversation history. */
  getConversation(): readonly Message[]
  /** Full execution history — one record per turn. */
  getExecutionHistory(): readonly TurnRecord[]
  clearSession(): void
}
```

---

## `demo/agent/kernel.ts` — Phase A

The deliberate → plan → execute → reconcile loop. Pure function; no class state.

```ts
export async function runKernel(
  conversation: Message[],    // mutable — kernel appends new messages here at reconcile
  config:       AgentConfig,
  context: {                  // what the model sees this turn
    system?:  string          // assembled system string (config.systemPrompt in Phase A)
    messages: Message[]       // broker-selected messages (= conversation in Phase A)
  },
  emit:         AgentEventSink,
  signal?:      AbortSignal,
): Promise<TurnRecord[]>
```

**Context injection contract:** `context.messages` is what the LLM call receives. In Phase A,
the caller passes `{ system: config.systemPrompt, messages: conversation }`. In Phase C+,
`CodingAgent` calls `broker.assemble(query)` and passes `assembled.messages` — which is the
broker-selected tail, not the full raw array. The broker controls both what's in `system`
(facts, summaries, context sections rendered via IPromptEngine) and which raw turns appear
as `messages`. This is the boundary that makes context selection real.

**One turn — four explicit steps:**

```
guard: signal?.aborted → emit error (abort), return

── Step 1: Deliberate ─────────────────────────────────────────────────────────
  transition: idle → deliberating
  provider = router.select('balanced')
  response = await provider.turn({
    system:   context.system,
    messages: context.messages,   // broker-selected (Phase C+) or raw conversation (Phase A)
    tools:    tools.tools(),
    // Phase F: stopSequences from config; Phase A: none
  })
    llm_transport_error / llm_protocol_error → transition to failed, emit error, return
  transition: deliberating → planning(response)
  emit message_end

── Step 2: Plan ───────────────────────────────────────────────────────────────
  stopReason === 'end_turn' | 'stop_sequence':
    // Both are natural stops. stop_sequence fires only when stopSequences is configured;
    // absent configuration it should not fire — treat any occurrence as end_turn.
    // COMMIT THIS TURN before checking for follow-ups:
    transition: planning → reconciling
    append AssistantMessage to conversation
    commit TurnRecord (outcome='answered') to execution store
    emit turn_end
    // Now check for follow-ups (a separate turn if present):
    followUps = await getFollowUpMessages?.()  (Phase F: honouring followUpMode)
    if followUps?.length:
      append follow-up messages to conversation
      emit turn_start (new turnId)
      loop from step 1  // each follow-up response is its own committed turn
    else:
      transition → done, break
  stopReason === 'max_tokens':
    transition → failed, outcome='partial', emit error, return
  stopReason === 'tool_use':
    plan = deduplicate toolCalls by callId (scope: this response only)
    transition: planning → executing(plan, completed=[])

── Step 3: Execute ────────────────────────────────────────────────────────────
  for each ToolPlan p:
    if signal?.aborted:
      mark p and all remaining as status='cancelled'
      break — interrupted (reason='abort')

    // Phase B: policy gate
    // Phase A: no policy — all calls allowed; skip this block
    if policy:
      decision = await policy.evaluate({ callId: p.callId, name: p.name,
                                         args: p.input, trustTier: p.trustTier })
      if decision.kind === 'deny' || decision.kind === 'confirm':
        // 'confirm' is treated as 'deny' until Phase F adds a confirmation channel.
        // Synthetic result appended; execution continues for remaining planned calls.
        execution = { callId: p.callId, plan: p, status: 'policy_denied' }
        completed.push(execution)
        emit tool_end
        continue  // next planned call
      if decision.kind === 'rewrite':
        p = { ...p, input: decision.args }  // execute with rewritten args; original in ToolPlan

    emit tool_start
    t0 = Date.now()
    raw = await tools.call(p.name, p.input, { signal })
    execution = { callId: p.callId, plan: p, status: raw.ok ? 'success' : 'runtime_failure',
                  result: raw, latencyMs: Date.now()-t0 }
    completed.push(execution)
    emit tool_end

    steering = await getSteeringMessages?.()
    if steering?.length:
      mark remaining plans as status='skipped'
      break — interrupted (reason='steering')

  // Protocol rule: the LLM contract requires a ToolResultMessage for EVERY tool_use
  // in an AssistantMessage. Skipped/cancelled/denied calls therefore MUST receive
  // synthetic ToolResultMessages. This is not optional — an unanswered tool call in
  // the conversation is invalid context for the next LLM call.
  //
  // Plan-as-history means the AssistantMessage is preserved intact (not stripped of
  // unexecuted calls). It does NOT mean synthetic results may be omitted.
  //
  // Synthetic result text examples:
  //   status='skipped':   "Skipped: steering interrupted before this call ran."
  //   status='cancelled': "Cancelled: AbortSignal fired before this call ran."
  //   status='policy_denied': "Denied by policy: <reason>."  [Phase B]

  if interrupted:
    record.interrupted = { plannedCalls, executedCalls, reason }
    // Append AssistantMessage + ToolResultMessages for ALL planned calls
    // (real results for completed; synthetic results for skipped/cancelled)
    append AssistantMessage to conversation
    append ToolResultMessages for all planned calls to conversation
    if reason='steering': append steering messages to conversation
    // Reconcile the interrupted turn before looping:
    commit TurnRecord (outcome='interrupted') to execution store
    emit turn_end
    loop from step 1  // continue session with fresh turn
  else:
    transition: executing → reconciling(plan, executions)

── Step 4: Reconcile ──────────────────────────────────────────────────────────
  append AssistantMessage + ToolResultMessages for all planned calls to conversation
  transition: reconciling → idle
  commit TurnRecord to execution store
  emit turn_end
  loop

guard: turnCount >= maxTurns → emit error (max_turns_exceeded), return
```

**Conversation append rule.** Every tool_use in an `AssistantMessage` must have a
corresponding `ToolResultMessage` — this is an LLM protocol requirement, not a design choice.
Skipped, cancelled, and denied calls all receive synthetic results.

**Plan-as-history.** The full `AssistantMessage` (all planned calls) is appended intact.
This preserves what the model intended, even when only some calls ran. The `TurnRecord`
records operational truth (`plan`, `executions`, `interrupted`). Conversation records
protocol truth.

---

## `demo/agent/CodingAgent.ts` — Phase A

Owns the three stores. Computes the system string (Phase A: plain `config.systemPrompt`;
Phase C+: `ContextBroker.assemble()`).

```ts
export class CodingAgent implements IAgent {
  private conversation: Message[] = []                    // protocol transcript — never trimmed
  private executions:   TurnRecord[] = []                  // operational truth — one per turn
  // Phase C adds: private summaries: Map<string, TurnSummary> = new Map()
  //   keyed by turnId; may have gaps (trivial turns skipped, not yet generated)

  constructor(private config: AgentConfig) {}

  async prompt(input: string, sink?: AgentEventSink): Promise<TurnRecord[]> {
    this.conversation.push({ role: 'user', content: input })
    return this._run(input, sink ?? noop)
  }

  async continue(sink?: AgentEventSink): Promise<TurnRecord[]> {
    return this._run(null, sink ?? noop)
  }

  private async _run(userInput: string | null, emit: AgentEventSink): Promise<TurnRecord[]> {
    const before = this.executions.length
    emit({ type: 'agent_start' })
    try {
      // Phase A: pass raw conversation as model-visible messages.
      // Phase C+: broker assembles system + selected message tail; broker output
      //           replaces both system and messages passed to the kernel.
      let context: { system?: string; messages: Message[] }
      try {
        context = this.config.contextBroker
          ? await this.config.contextBroker.assemble(this._buildQuery(userInput))
          : { system: this.config.systemPrompt, messages: this.conversation }
      } catch (e) {
        // context_error — fires BEFORE turn_start; no turn has started, no TurnRecord appended.
        // No fallback: a raw-messages fallback is unsafe in long sessions (context overflow).
        const failure: Failure = { kind: 'context_error', message: String(e) }
        emit({ type: 'error', failure })
        return []
      }

      const records = await runKernel(
        this.conversation,   // mutable: kernel appends messages here at reconcile
        this.config,
        context,             // what the model sees: system + selected messages
        emit,
      )
      for (const r of records) this.executions.push(r)
      return this.executions.slice(before)
    } finally {
      emit({ type: 'agent_end', records: this.executions })
    }
  }

  private _buildQuery(userInput: string | null): AgentContextQuery {
    // CodingAgent owns the stores; it passes the full conversation and all summaries.
    // The broker computes its own tail window from AgentContextQuery.conversation using
    // tailTurns from its own config — it does not receive a pre-sliced tail.
    return {
      userInput:     userInput ?? '',
      conversation:  this.conversation,          // full history; broker selects its own tail
      turnSummaries: [...(this.summaries?.values() ?? [])],  // keyed by turnId; may have gaps
      tokenBudget:   this.config.tokenBudget ?? 28_000,
    }
  }

  getConversation()      { return this.conversation as readonly Message[] }
  getExecutionHistory()  { return this.executions   as readonly TurnRecord[] }
  clearSession()         { this.conversation = []; this.executions = []; this.summaries?.clear() }
}
```

---

## Phase A invariants

- Exactly one `agent_start` and one `agent_end` per call. `agent_end` always fires.
- Every `turn_start` has a matching `turn_end` or a terminal `error` — never both, never neither.
- **A turn is committed exactly once at reconcile, regardless of outcome.** Reconcile appends
  conversation messages and commits the `TurnRecord` atomically.
- `TurnRecord` is always appended if `turn_start` was emitted — i.e., if a turn started in
  the state machine sense. `context_error` is the only category where this doesn't apply
  because context assembly runs before `turn_start` is emitted.
- Conversation is a protocol transcript. It records what was planned and what the protocol
  requires (including synthetic results) — not a normalized record of completed actions.
- Policy-denied calls (Phase B) produce synthetic `ToolResultMessage`s that appear in
  conversation — the protocol requires a result for every call in an `AssistantMessage`.
  `ToolExecution.status: 'policy_denied'` is the authoritative source for operational truth.
- Conversation is never mutated mid-turn. Appends happen atomically at reconcile.
- Tool call ID deduplication scope is the current provider response only.
- `router.select()` is called once per turn, not once per run.
- Synthetic `ToolResultMessage`s for cancelled/skipped calls use the same message schema as
  runtime error results — distinguishable only via `TurnRecord`.

## Phase A usage

```ts
import { createCodingAgent, createCodingTools } from './demo/agent/index.js'
import { AnthropicProvider } from './providers/index.js'
import type { IModelRouter } from './contracts/llm.js'

const provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! })
const router: IModelRouter = { select: () => provider }

const agent = createCodingAgent({
  router,
  tools: createCodingTools({ cwd: process.cwd() }),
  systemPrompt: 'You are a coding assistant. Read files before editing them.',
})

const records = await agent.prompt('What does the entry point do?', (event) => {
  if (event.type === 'message_end') process.stdout.write(event.message.content + '\n')
  if (event.type === 'tool_end')    console.log(`  ${event.name} → ${event.execution.status}`)
})
```

---

# Phase B — Policy & Trust

**Depends on:** Phase A

**Goal:** Formal tool policy as a first-class layer. `beforeToolCall` (Phase F) is for
extensibility hooks; policy is for runtime enforcement. External content is treated as typed
artifacts — not just strings with a label in the prompt.

**Primitives introduced:** `IToolRegistry`, `ToolTrustTier`

## New files

```
demo/agent/tool-policy.ts    DefaultToolPolicy — demo-specific default implementation
demo/agent/artifact.ts       ExternalArtifact — typed external content
```

## Changes to existing files

```
demo/agent/config.ts      + policy?: IToolPolicy (from @nucleic-se/agentic/contracts)
                          + registry?: IToolRegistry
contracts/agent.ts        + ToolPlan gains trustTier: ToolTrustTier
                          + ToolExecution gains artifact?: ExternalArtifact for untrusted sources
demo/agent/kernel.ts      + policy.evaluate() before each tool execution (see Step 3 below)
```

---

## `demo/agent/tool-policy.ts`

`IToolPolicy`, `PolicyContext`, and `PolicyDecision` are defined in `@nucleic-se/agentic/contracts`
and are the canonical types used throughout. This file contains only the demo's default
implementation.

```ts
import { TrustTierToolPolicy } from '@nucleic-se/agentic/runtime'
import type { IToolPolicy, PolicyContext, PolicyDecision } from '@nucleic-se/agentic/contracts'

// PolicyContext (from contracts):
//   callId: string; name: string; args: Record<string, unknown>; trustTier: ToolTrustTier
//
// PolicyDecision (from contracts):
//   | { kind: 'allow' }
//   | { kind: 'rewrite'; args: Record<string, unknown>; reason: string }
//   | { kind: 'deny';    reason: string }
//   | { kind: 'confirm'; reason: string }
```

**`DefaultToolPolicy`** — extends `TrustTierToolPolicy` (library), adds untrusted-tier handling:

```ts
export class DefaultToolPolicy extends TrustTierToolPolicy {
  // TrustTierToolPolicy already denies unknown tools and allows all registered tools.
  // Override to add untrusted-tier enforcement and any domain-specific rules.

  async evaluate(ctx: PolicyContext): Promise<PolicyDecision> {
    // 'untrusted' tools are allowed — the execute step normalises the result into an
    // ExternalArtifact for structured tracking. Override here to require confirmation instead.
    return super.evaluate(ctx)
  }
}
```

**`confirm` decision in Phase B.** When `evaluate()` returns `{ kind: 'confirm' }`, Phase B
treats it as `deny` with `reason: 'Pending confirmation: ' + reason`. The `ToolExecution` is
recorded with `status: 'policy_denied'` and a synthetic `ToolResultMessage` is appended.
Full confirmation-gate semantics (pausing the loop, awaiting user input, resuming) are a
Phase F concern that requires designing the interaction channel alongside the steering/follow-up
queue model. The kernel's handling is a forward-compatible placeholder.

The policy layer is the right place to add: call budget enforcement, session-level rate
limiting, domain allow/deny lists, and require-confirmation gates — without coupling any of
that to hook ordering or loop mechanics.

---

## `demo/agent/artifact.ts`

External content (fetch results, search hits, large shell outputs) is a first-class type,
not just a string injected into the prompt.

```ts
export interface ExternalArtifact {
  id:                   string
  source:               'fetch' | 'search' | 'shell' | 'fs'
  trustTier:            ToolTrustTier
  content:              string            // potentially clipped — see clippedAt
  clippedAt?:           number            // byte offset if content was truncated
  fullContentPath?:     string            // temp file path for full output (Phase F)
  metadata:             Record<string, unknown>
  containsInstructions: boolean           // heuristic: does content contain imperative sentences?
  timestamp:            number
}
```

When the tool policy evaluates an `untrusted` tool result, the result is normalised into an
`ExternalArtifact`:
- Content clipped at 4000 tokens before entering context
- `containsInstructions` flag detected with a lightweight heuristic
- The `ToolExecution.artifact` field carries the structured object — the runtime retains
  safety metadata even after the string is injected into the prompt

---

## Trust tier assignment

| Tool | Tier | Rationale |
|---|---|---|
| `fs_read`, `search_files` | `trusted` | Read-only, deterministic |
| `fs_write`, `fs_delete`, `fs_move`, `shell_exec` | `standard` | Mutations with known schemas |
| `fetch_json`, `fetch_text` | `untrusted` | External internet content |

---

# Phase C — Context Broker

**Depends on:** Phase A, B

**Goal:** Replace naive "pass all messages every turn" with a ContextBroker that separates
*what to include* (selection) from *how to render it* (rendering). Uses `IPromptEngine` for
final budget enforcement. Introduces `TurnSummary` as the primary compression strategy —
not emergency compaction.

**Primitives introduced:** `IPromptEngine`, `IPromptContributor`, `ToolPromptRenderer`

## New files

```
demo/agent/context-broker.ts      ContextBroker — selection + rendering + budget
demo/agent/turn-summarizer.ts     TurnSummary type + summarize() function
demo/agent/session-file-tracker.ts Accumulates read/write paths across budget trims
```

## Changes to existing files

```
demo/agent/config.ts      + contextBroker?, promptEngine?, tokenBudget?, tailTurns?
demo/agent/CodingAgent.ts + _buildQuery(); call broker.assemble(); pass assembled context
                            (system + messages) to kernel — not just the system string
contracts/agent.ts        + TurnRecord.contextUsed: ContextCandidate[]
demo/agent/kernel.ts      + context parameter replaces bare system string; uses
                            context.messages for LLM call instead of raw conversation
```

---

## Candidate normalisation and scoring

All sources of context are normalised into a `ContextCandidate` before scoring. This
keeps candidate generation and selection independently testable.

```ts
// Identifies where a candidate originated — used in debug spans and TurnRecord.contextUsed.
export type ContextSource =
  | 'system_prompt'         // base system instructions
  | 'tool_catalog'          // tool definitions
  | 'scratchpad'            // active task state from FactStore
  | 'fact'                  // retrieved Fact from FactStore
  | 'turn_summary'          // TurnSummary for an older turn
  | 'session_file_tracker'  // cumulative read/write path list
  | 'raw_turn'              // raw Message[] for recent turns
  | 'active_file'           // file content for files touched in last 2 turns

export type CandidateLane =
  | 'sticky'        // system, tools, files — never dropped
  | 'must_include'  // scratchpad, unresolved summaries, active files — dropped only under
                    // critical budget pressure
  | 'working_state' // scratchpad (if not must_include)
  | 'semantic'      // facts
  | 'historical'    // TurnSummaries
  | 'structural'    // SessionFileTracker
  | 'tail'          // last N raw conversation turns (high priority, not unconditional)

export interface ContextScore {
  recency:   number   // 0–1: how recent relative to the current turn
  relevance: number   // 0–1: how related to current user input; see floors below
  authority: number   // 0–1: base + dynamic boost; see authority table
}

export interface ContextCandidate {
  source:      ContextSource
  content:     string
  lane:        CandidateLane
  mustInclude: boolean
  score:       ContextScore
  metadata: {
    turnId?:      string
    confidence?:  number   // for facts
    tokens?:      number
  }
}
```

### Soft-floor composite score

A purely multiplicative score collapses when any single axis is low — an old but critical
fact with low keyword overlap scores near zero and gets dropped incorrectly.

```
score = effectiveAuthority × (0.5 + 0.5 × recency) × (0.5 + 0.5 × relevance)
```

The soft floor of 0.5 on recency and relevance means the minimum score is
`authority × 0.25` — never zero. Authority still dominates when all axes are high.

### Lane soft-cap budgeting

After sticky + must-include candidates are placed, remaining budget `R` is allocated
across lanes using soft caps. Underspend in one lane carries forward to the next.

| Lane | Soft cap | Overflow policy |
|---|---|---|
| `tail` | 60% of R | Unused → historical |
| `historical` | 25% of R | Unused → semantic |
| `semantic` | 15% of R | Unused → working_state |
| `working_state` | Remaining | Last to fill |

IPromptEngine makes the final hard cut on whatever sections are submitted after lane filling.

### Raw-tail vs trust-tier-rendered results — one representation, not two

Tool results in `messages` and tool results in `system` are separated by the tail boundary.
The same result never appears in both:

- **In tail** (recent N turns): raw `ToolResultMessage` objects in `messages`
- **Older than tail**: summarised via `TurnSummary` in `system` (IPromptEngine section)

`ToolPromptRenderer` is used only for rendering results into `system`. It is not applied to
results already present in `messages` as raw protocol turns. When a turn exits the tail and
gets compressed to a summary, its `ToolResultMessage`s leave `messages` permanently.

### Dynamic authority

Base values with contextual boosts applied at scoring time:

| Source | Base | Boost condition |
|---|---|---|
| System / tool catalog | 1.0 (sticky) | — |
| Trusted tool results | 0.9 | — |
| Standard tool results | 0.7 | — |
| Scratchpad | 0.85 | +0.1 if `mustInclude` |
| Facts | 0.75 | +0.15 if relevance > 0.7 |
| TurnSummary | 0.6 | +0.2 if `unresolvedItems.length > 0` |
| SessionFileTracker | 0.5 (sticky) | — |
| Untrusted artifacts | 0.5 | — |

### Relevance floors

Keyword overlap fails for paraphrasing and structural queries. To prevent losing active task
state due to a vocabulary mismatch:
- Summaries with `unresolvedItems.length > 0`: minimum relevance **0.4**
- Scratchpad: minimum relevance **0.5**
- Phase E facts matched by embedding (cosine > 0.65): relevance = 0.8, bypassing keyword

### IPromptEngine encoding

```
IPromptSection.priority          = effectiveAuthority × 100
IPromptSection.weight            = 0.5 + 0.5 × recency     (soft-floor recency)
IPromptSection.contextMultiplier = 0.5 + 0.5 × relevance   (soft-floor relevance)
```

---

## `demo/agent/context-broker.ts`

```ts
export interface AssembledContext {
  system:     string                 // assembled via IPromptEngine: facts, summaries, context
  messages:   Message[]              // ← the model-visible conversation sequence; broker-selected
                                     //   tail turns only; NOT the full raw conversation
  selections: ContextCandidate[]     // for TurnRecord.contextUsed (lane + score + metadata)
  stats:      PromptComposeResult    // included/excluded/totalTokens from IPromptEngine
}

export interface AgentContextQuery {
  userInput:     string
  conversation:  Message[]       // full raw history — broker selects its own tail window
  turnSummaries: TurnSummary[]   // summaries for older turns; may have gaps (keyed by turnId)
  tokenBudget:   number
}
// CodingAgent constructs AgentContextQuery before each kernel call (see _buildQuery).
// The broker receives the full conversation and computes its own tail using AgentConfig.tailTurns.
// Summaries cover turns older than the tail; gaps are allowed (trivial turns may lack summaries).

export interface ContextBroker {
  assemble(query: AgentContextQuery): Promise<AssembledContext>
}
// Note: ContextBroker is the demo's session-aware context assembler. It is a richer variant
// of the library's IAgentContextAssembler (which takes only { userInput, messages, tokenBudget })
// because it also receives TurnSummaries. Library consumers who don't need session summaries can
// use IAgentContextAssembler / PassThroughContextAssembler directly. The demo uses ContextBroker.
```

**Default implementation flow:**

```
1. Sticky (lane='sticky'): system, tool catalog, SessionFileTracker — budget reserved
2. Must-include (lane='must_include'): scratchpad if non-empty; summaries with
   unresolvedItems; files touched in last 2 turns — dropped only under critical pressure
3. Normalise remaining candidates → ContextCandidate[] with lane assignments
     tail lane:      query.conversation.slice(-tailTurns * avgMsgsPerTurn)
                     (broker computes its own window; tailTurns default: 3)
     historical lane: query.turnSummaries for turns older than the tail
     semantic lane:  facts from FactStore (Phase E)
     working_state:  scratchpad (Phase E, if not already in must_include)
4. Apply soft-floor scoring + dynamic authority boosts + relevance floors
5. Intra-lane ranking → top candidates per lane compete for remaining budget
6. Build PromptSection[] with soft-floor IPromptEngine encoding
7. IPromptEngine.compose(sections, tokenBudget) — final hard budget cut
8. Collect ContextCandidate[] metadata for TurnRecord.contextUsed
9. Return AssembledContext — messages contains only the tail turns selected in step 3/5
```

`IPromptEngine` is the safety net — enforces the hard budget limit after selection has
already ranked candidates. Debugging has two clean questions: *did selection pick the wrong
things?* (check scores and lanes) or *did budget enforcement drop the right things?*
(check reason codes and token estimates in span metadata).

---

## `demo/agent/turn-summarizer.ts`

Summaries are the primary mechanism for compressing older turns. They are generated eagerly
after each turn — not as an emergency fallback.

```ts
export interface TurnSummary {
  turnId:          string
  userIntent:      string
  toolsUsed:       string[]
  filesRead:       string[]
  filesModified:   string[]
  keyFindings:     string[]
  unresolvedItems: string[]
  outcome:         TurnOutcome
  tokenEstimate:   number       // estimated size of this summary in tokens
}

export async function summarizeTurn(
  record:  TurnRecord,
  router:  IModelRouter,   // router.select('fast')
): Promise<TurnSummary>
```

**Summaries are context hints, not ground truth.** They are lossy, model-generated, and
potentially wrong. The execution store (`TurnRecord`) is the authoritative record of what
happened. If a summary contradicts tool results in the execution store, the execution store
wins. Summaries may be regenerated (better prompt, different model tier) without changing
execution history.

**When summaries replace raw turns in context:**

- The last N turns (default: 3) are high-priority in the `tail` lane; almost always survive
- Older turns are represented by their `TurnSummary`, scored by recency and unresolved-items boost
- Summaries with `unresolvedItems` are in the `must_include` tier — dropped only under critical
  budget pressure
- If a summary is excluded: `SessionFileTracker` preserves the file footprint

**Why this is better than compaction:**
- Summaries are generated per-turn, not on overflow — quality is consistent across the session
- Raw `TurnRecord`s always coexist in the execution store — no information is lost
- The model is never given a degraded view without knowing it received a degraded view

---

## Context assembly span (debug traces)

When `ISpanTracer` is available (Phase D), the broker traces:

```ts
// in the context.assemble span:
metadata: {
  sectionsIncluded: number,
  sectionsExcluded: number,
  totalTokens:      number,
  topIncluded: [{ source, lane, score, tokens }],
  topExcluded: [{ source, lane, score, tokens, reason }],
}
```

Reason codes: `budget_exceeded` | `lower_score` | `lane_budget_exhausted` |
`sticky_reserved_budget`

---

## `demo/agent/session-file-tracker.ts`

File paths are tracked independently of context budget. Even when all turn summaries for a
session are dropped from context, the model always knows what it has touched.

```ts
export class SessionFileTracker {
  private read    = new Set<string>()
  private written = new Set<string>()

  /** Call after each ToolExecution with status='success'. */
  record(toolName: string, args: Record<string, unknown>, affectedPaths?: string[]): void
  // Records both requested path (from args) and observed affected paths

  /** Returns a sticky PromptSection — null if both sets are empty. */
  toPromptSection(): PromptSection | null
  // sticky: true, phase: 'constraint', lane: 'sticky'
  // text: "Files read:\n  src/index.ts\n...\nFiles modified:\n  ..."
  //
  // Why sticky: acts as a persistent working-set anchor. Under extreme budget pressure,
  // all TurnSummaries may be dropped; the model still knows what it has touched.
  // Without this, the model can lose track of its working set and re-read files already
  // processed. At ~50 tokens, it unconditionally earns its reserved budget.
}
```

---

## Split-turn edge case

The one case `IPromptEngine` cannot resolve: a single turn summary that exceeds the full
remaining budget. Fallback:

```
1. Detect: IPromptEngine excludes a section that is the only non-sticky candidate
2. Truncate key findings and tool results within the summary to 200 chars each
3. Re-run compose() — almost always fits
4. If still excluded: drop the summary entirely
   The session-file-tracker section preserves the file footprint.
   The full TurnRecord remains in the execution store for replay.
```

No compaction-style LLM call is needed. Raw records are never lost — only their context
representation is degraded.

---

# Phase D — Observability

**Depends on:** Phase A

**Goal:** Every meaningful operation has a hierarchical span. Events are UI-facing; spans
are debugging- and performance-facing; `TurnRecord` is replay-facing. These are three
separate concerns and should not be collapsed.

**Primitives introduced:** `ISpanTracer`, `TraceSpan`

## New files

None. Tracing is wired additively into existing files. When `tracer` is absent, all span
calls are guarded no-ops.

## Changes to existing files

```
demo/agent/config.ts          + tracer?: ISpanTracer
demo/agent/kernel.ts          + open/close spans around llm.call and each tool execution
demo/agent/CodingAgent.ts     + open/close root agent.run span in _run()
demo/agent/context-broker.ts  + tracer?: ISpanTracer constructor param; open/close span
                                around assemble() — broker holds a reference injected at
                                construction time via DefaultContextBroker(engine, tracer?)
demo/agent/turn-summarizer.ts + open/close span around summarize()
```

---

## Span hierarchy

```
agent.run  (correlationId = per-session UUID)
  ├── context.assemble
  │     metadata: { sectionsIncluded, sectionsExcluded, totalTokens,
  │                 topIncluded: [{source, score}],
  │                 topExcluded: [{source, score, reason}] }
  ├── turn.1
  │     ├── llm.call
  │     │     metadata: { model, tier:'balanced', inputTokens, outputTokens,
  │     │                 stopReason, latencyMs }
  │     ├── tool.fs_read
  │     │     metadata: { trustTier, status, latencyMs }
  │     └── tool.shell_exec
  │           metadata: { trustTier, status, latencyMs, exitCode }
  ├── turn.summarize
  │     metadata: { model, tier:'fast', inputTokens, outputTokens, latencyMs }
  ├── turn.2
  │     └── llm.call  ...
  └── (Phase E: facts.extract, memory.write)
```

---

## `AgentConfig` additions — Phase D

```ts
// demo/agent/config.ts
tracer?: ISpanTracer
```

---

# Phase E — Memory

**Depends on:** Phases A, B, C, D

**Goal:** Persistent knowledge that survives across turns. Introduced only after the
execution kernel, policy layer, and context broker are solid — because memory multiplies
every pre-existing mistake.

Two concepts rather than four tiers up front:
- **Scratchpad** — session-scoped, short-lived, mutable. For active task state.
- **Facts** — longer-lived, provenance-backed, policy-gated. For durable knowledge.

The four `IMemoryStore` tiers (working / episodic / semantic / procedural) are the backing
implementation, but `scratchpad` and `facts` are the product-level concepts exposed to the
agent and the context broker.

**Primitives introduced:** `IMemoryStore`, `ILLMProvider.structured()`

## New files

```
demo/agent/fact-store.ts       FactStore wrapping IMemoryStore — scratchpad + facts + write policy
demo/agent/fact-extractor.ts   Post-turn structured extraction into FactStore
```

## Changes to existing files

```
demo/agent/config.ts           + factStore?: FactStore
demo/agent/context-broker.ts   + query FactStore in assemble() → facts + scratchpad sections
demo/agent/CodingAgent.ts      + call FactExtractor after qualifying turns
```

---

## `demo/agent/fact-store.ts`

```ts
export interface Fact {
  id:         string
  key:        string
  value:      string
  confidence: number       // 0.0–1.0
  observed:   boolean      // true = grounded in tool result; false = inferred
  source:     string       // "turn:{id}:{toolName}" or "turn:{id}:inference"
  createdAt:  number
  updatedAt:  number
  ttlDays?:   number
  tags:       string[]
}

export interface FactStore {
  // Scratchpad — session-scoped, write/overwrite freely
  setScratchpad(key: string, value: string): Promise<void>
  getScratchpad(): Promise<Record<string, string>>
  clearScratchpad(): Promise<void>

  // Facts — policy-gated
  propose(fact: Omit<Fact, 'id' | 'createdAt' | 'updatedAt'>): Promise<WriteOutcome>
  query(query: { text?: string; tags?: string[]; limit: number; tokenBudget?: number }): Promise<Fact[]>
  evictExpired(): Promise<number>
}

export type WriteOutcome =
  | { accepted: true;  fact: Fact }
  | { rejected: true;  reason: string }
  | { updated:  true;  fact: Fact; previous: Fact }
```

**`FactStore` is backed by `IMemoryStore`:**
- Scratchpad → `working` tier
- Facts → `semantic` / `procedural` / `episodic` tiers based on content classification

---

## Memory write policy

The policy is encoded in `FactStore.propose()`. These rules are enforced at write time, not
inferred at read time.

**Confidence thresholds:**
- Reject any fact with `confidence < 0.4`
- `procedural` facts (user preferences) require `confidence >= 0.7`

**Grounding requirement:**
- `observed: true` requires `source` to include a tool name
- `semantic` facts (codebase knowledge) must be `observed: true` — inferred codebase facts
  are rejected

**Deduplication:**
- Key: `(type, key)` — same type + key is the same fact
- Update if `confidence >= current.confidence`, or values are meaningfully different

**Conflict resolution:**
- Conflicting `semantic` facts: new wins only if `confidence > existing.confidence`
- The superseded entry is preserved in span metadata, not silently overwritten

**Provenance:**
```ts
source: "turn:{turnId}:{toolName}"   // observed via tool
source: "turn:{turnId}:inference"    // inferred — only allowed for episodic tier
```

---

## `demo/agent/fact-extractor.ts`

Runs after qualifying turns. Uses `ILLMProvider.structured()` on the `fast` tier.

**Qualification gate** — skip extraction when the turn is clearly trivial:
- Assistant message contains fewer than 200 tokens, **and**
- Zero tool calls were made

```ts
export async function extractFacts(
  record:    TurnRecord,
  router:    IModelRouter,    // router.select('fast')
  factStore: FactStore,
): Promise<void>
```

The extraction prompt receives the full `TurnRecord` including tool results — so the model
can ground `semantic` facts in observed data rather than reasoning about possibilities.

**Memory tier routing heuristic:**

| What the model says about a fact | Tier |
|---|---|
| "The user prefers X" / "User corrected me" | `procedural` |
| "I just did X and the result was Y" | `episodic` |
| "File X is the entry point" (observed via fs_read) | `semantic` |
| "Current task: implement Y" | scratchpad |

---

## `AgentConfig` additions — Phase E

```ts
// demo/agent/config.ts
factStore?: FactStore
// router already present; fast tier used for extraction and turn summarization
```

---

# Phase F — Extensions

**Depends on:** Phases A–E

**Goal:** Surface the full extensibility layer. Hooks, pipelines, streaming progress events,
pluggable tool operations, three-layer message model, and production config loading.
Extensions come last because they multiply correctness assumptions from earlier phases.

**Primitives introduced:** `ITickPipeline`, `ITickStep`, `TickContext` (extended)

## New files

```
demo/agent/turn-pipeline.ts         ITickPipeline — pre/post-turn lifecycle steps
demo/agent/agent-message.ts         AgentMessage layer + toLlmMessages()
demo/agent/tool-operations.ts       Pluggable execution interfaces
demo/agent/config-loader.ts         Three-level config resolution
demo/agent/system-prompt-builder.ts Modular system prompt with cross-tool guidelines
```

## Changes to existing files

```
demo/agent/config.ts      + beforeToolCall, afterToolCall, transformMessages,
                            onBeforeLlmCall, steeringMode, followUpMode
contracts/agent.ts        + tool_progress event added to AgentEvent
demo/agent/kernel.ts      + call Phase F hooks in fixed order; thread signal to tools.call();
                            emit tool_progress from onUpdate; apply queue flush modes
demo/agent/CodingAgent.ts + history becomes AgentMessage[]; add getAllMessages()
demo/agent/tools.ts       + ops?: Partial<ToolOperations>
```

---

## Hook execution order

Defined here; fixed. All hooks are awaited sequentially.

```
1. transformMessages()         — once per prompt(), before the kernel starts
2. onBeforeLlmCall()           — before every individual LLM call within the loop
3. [LLM call]
4. policy.evaluate()           — Phase B; before beforeToolCall
5. beforeToolCall()            — Phase F hook; after policy, before execution
6. [tool execution + onUpdate → tool_progress events]
7. afterToolCall()             — Phase F hook; may mutate result content/isError
8. getSteeringMessages()       — after afterToolCall, per tool
9. getFollowUpMessages()       — after end_turn with no steering
```

---

## `ITickPipeline` for turn lifecycle

Extracts the work accumulated across Phases C–E into ordered, replaceable steps.

**Pre-turn pipeline:**

| Step ID | Order | Action | Failure policy |
|---|---|---|---|
| `open-span` | 5 | Open root span | Optional — continue without tracing |
| `evict-expired` | 10 | `factStore.evictExpired()` | Optional — soft error in span |
| `assemble-context` | 20 | `contextBroker.assemble()` | **Required** — abort if context assembly fails |
| `log-context-stats` | 30 | Trace selection stats | Optional — no-op |

**Post-turn pipeline:**

| Step ID | Order | Action | Failure policy |
|---|---|---|---|
| `summarize-turn` | 10 | `summarizeTurn()` for the completed turn | Optional — skip silently |
| `extract-facts` | 20 | `extractFacts()` from the completed turn | Optional — skip silently |
| `close-span` | 30 | Close root span | Optional — best-effort |

`agent_end` is not a pipeline step — it remains in `CodingAgent._run()` `finally`.

Steps are replaceable by ID — register a step with the same ID to override behaviour.

---

## Three-layer message model

```ts
// demo/agent/agent-message.ts

export type AgentMessage =
  | Message                                               // LLM-visible: persisted + sent
  | { role: 'session_only'; kind: string; data: unknown } // persisted, never sent to LLM
  | { role: 'ephemeral'; content: string }                // sent this call only, not persisted

export function toLlmMessages(messages: AgentMessage[]): Message[] {
  return messages.filter((m): m is Message =>
    m.role === 'user' || m.role === 'assistant' || m.role === 'tool_result'
  )
}
```

`CodingAgent` history becomes `AgentMessage[]` internally. `kernel.ts` calls `toLlmMessages()`
at the LLM boundary.

`IAgent` additions:
```ts
interface IAgent {
  // existing methods unchanged
  getAllMessages(): readonly AgentMessage[]   // full application-layer history
}
```

---

## Hook contracts

**`beforeToolCall` / `afterToolCall`:**

```ts
export interface BeforeToolCallContext {
  callId:    string
  name:      string
  input:     unknown
  trustTier: ToolTrustTier   // available after Phase B
  policy:    PolicyDecision   // the policy decision already made
}

export type BeforeToolCallResult =
  | { proceed: true;  input?: unknown }
  | { proceed: false; reason: string }

export interface AfterToolCallContext {
  callId:    string
  name:      string
  input:     unknown
  execution: ToolExecution
  latencyMs: number
}

export interface AfterToolCallResult {
  content?: string    // override what the LLM sees
  isError?: boolean   // override failure flag
}
```

**Steering / follow-up flush modes:**

```ts
steeringMode?:  'all' | 'one-at-a-time'  // default: 'all'
followUpMode?:  'all' | 'one-at-a-time'  // default: 'one-at-a-time'
```

**`tool_progress` event:**

```ts
| { type: 'tool_progress'; turnId: string; callId: string; name: string; details: unknown }
```

Emitted from an `onUpdate` callback threaded to tools that support streaming partial results.
Requires `IToolRuntime.call()` to gain optional `signal?` and `onUpdate?` parameters —
additive, backwards-compatible.

---

## Pluggable tool operations

```ts
// demo/agent/tool-operations.ts

export interface BashOperations {
  exec(command: string, cwd: string, opts: {
    signal?:  AbortSignal
    onData?:  (chunk: string) => void  // incremental — enables streaming truncation
    timeout?: number
    env?:     Record<string, string>
  }): Promise<{ exitCode: number; stdout: string; stderr: string }>
}

export interface FsOperations {
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  deleteFile(path: string): Promise<void>
  listDir(path: string): Promise<string[]>
}
```

`createCodingTools(opts?)` gains `ops?: Partial<ToolOperations>`. Swap for SSH, Docker, or
a custom sandbox without changing tool schemas or agent config.

**Shell output truncation** (added to `ShellToolRuntime` via `BashOperations.onData`):

```
Limits: 100 lines  OR  48 KB — whichever is hit first.
Incremental: buffer via onData, truncate at boundary, never load full output into memory.
If exceeded: write remainder to /tmp/agent-shell-<id>.log
Return: truncated output + "Full output at: <path>"
ToolExecution.artifact carries: { fullContentPath?, clippedAt?, originalLineCount, originalByteCount }
```

---

## Config hierarchy

```ts
// demo/agent/config-loader.ts

// Resolution order: runtimeOverrides > .agent/settings.json > ~/.agent/settings.json
export async function loadAgentConfig(
  overrides:  Partial<AgentConfig>,
  projectDir?: string,
): Promise<AgentConfig>
```

Settings file:
```json
{
  "tokenBudget": 28000,
  "maxTurns": 20,
  "systemPrompt": "...",
  "tools": { "allowShell": true, "allowFetch": false },
  "memory": { "ttlDays": { "scratchpad": 1, "facts": 30 } }
}
```

---

## System prompt builder

```ts
// demo/agent/system-prompt-builder.ts

export function buildSystemPrompt(opts: {
  base?:         string
  cwd?:          string
  guidelines?:   string[]
  contextFiles?: Array<{ path: string; content: string }>
  toolNames?:    string[]    // auto-derive cross-tool rules
  append?:       string
}): string
```

**Cross-tool rules from `toolNames`:**

| Tools present | Rule injected |
|---|---|
| `search_files` + `shell_exec` | Prefer `search_files` over `shell_exec` for searching |
| `fs_read` + `shell_exec` | Prefer `fs_read` over `cat` in shell for reading files |
| `fetch_text` + `fs_read` | Use `fs_read` for local files, not `fetch_text` |

---

## Complete file map

```
contracts/
  agent.ts                       NEW — shared zero-runtime protocol types. No imports from demo/.
                                       Phase A: AgentState, TurnRecord, ToolPlan, ToolExecution,
                                               Failure, FailureKind, TurnOutcome, AgentEvent,
                                               AgentEventSink, IAgent.
                                       (AgentConfig lives in demo/agent/config.ts, not here.)

demo/agent/
  implementation_plan.md         THIS FILE

  ── Phase A ──────────────────────────────────────────────────────────
  config.ts                      NEW — AgentConfig. References demo-layer types (ContextBroker,
                                       IToolPolicy, FactStore, hook contexts). Not in contracts/
                                       because it depends on demo/ abstractions.
  kernel.ts                      NEW — deliberate/plan/execute/reconcile loop (pure function)
  CodingAgent.ts                 NEW — stateful wrapper, owns three stores, implements IAgent
  tools.ts                       NEW — createCodingTools() factory
  index.ts                       NEW — barrel + createCodingAgent()

  ── Phase B ──────────────────────────────────────────────────────────
  tool-policy.ts                 NEW — DefaultToolPolicy (extends TrustTierToolPolicy from library;
                                       IToolPolicy / PolicyContext / PolicyDecision from contracts/)
  artifact.ts                    NEW — ExternalArtifact, normalisation

  ── Phase C ──────────────────────────────────────────────────────────
  context-broker.ts              NEW — ContextBroker, 3-axis selection + IPromptEngine rendering
  turn-summarizer.ts             NEW — TurnSummary, summarizeTurn()
  session-file-tracker.ts        NEW — cumulative read/write path tracking

  ── Phase D ──────────────────────────────────────────────────────────
  (no new files — ISpanTracer wired additively into existing files)

  ── Phase E ──────────────────────────────────────────────────────────
  fact-store.ts                  NEW — FactStore: scratchpad + facts + write policy
  fact-extractor.ts              NEW — post-turn structured extraction

  ── Phase F ──────────────────────────────────────────────────────────
  turn-pipeline.ts               NEW — ITickPipeline: pre/post-turn lifecycle steps
  agent-message.ts               NEW — AgentMessage layer + toLlmMessages()
  tool-operations.ts             NEW — BashOperations, FsOperations interfaces
  config-loader.ts               NEW — 3-level config resolution
  system-prompt-builder.ts       NEW — modular builder + cross-tool guidelines
```

**Total new files: 18** (`contracts/agent.ts` + 16 under `demo/agent/`). Designed to work
without modifying existing library source in the initial implementation. Streaming support
and richer tool cancellation may require additive contract extensions in later phases.

---

## Primitive showcase by phase

| Phase | Primitive | Where |
|---|---|---|
| A | `ILLMProvider.turn()` | `kernel.ts` — deliberate step (`balanced` tier) |
| A | `IModelRouter` | `kernel.ts` — `select('balanced')`; Phase C/E use `select('fast')` |
| A | `IToolRuntime` | `kernel.ts` — `tools()` for catalog, `call()` for execution |
| B | `IToolRegistry` | `tool-policy.ts` — trust tier lookup in `DefaultToolPolicy` |
| B | `ToolTrustTier` | `tools.ts` — explicit assignment; `artifact.ts` — tier on artifacts |
| C | `IPromptEngine.compose()` | `context-broker.ts` — budget enforcement after selection |
| C | `PromptSection` + phases | `context-broker.ts` — 3-axis scores encoded as priority/weight/multiplier |
| C | `IPromptContributor` | `context-broker.ts` — scratchpad/facts/summaries as contributors |
| C | `ToolPromptRenderer` | `context-broker.ts` — tier-labelled tool result sections |
| D | `ISpanTracer` | `kernel.ts`, `CodingAgent.ts`, `context-broker.ts`, `fact-extractor.ts` |
| E | `IMemoryStore` | `fact-store.ts` — backing store for scratchpad + facts |
| E | `ILLMProvider.structured()` | `fact-extractor.ts`, `turn-summarizer.ts` (fast tier) |
| F | `ITickPipeline` / `ITickStep` | `turn-pipeline.ts` — pre/post-turn lifecycle |
| F | `TickContext` (extended) | `AgentTickContext` — domain extension pattern |

---

## Open questions

- **Streaming.** `ILLMProvider.turn()` is request-response. Adding `stream(request):
  AsyncIterable<TurnDelta>` enables `message_update` delta events and real-time output.
  This is an additive contract extension; the kernel can adopt it without structural change.

- **Embedding-based retrieval.** `FactStore.query()` and `ContextBroker` currently use
  tag/text filtering for relevance scoring. Using `ILLMProvider.embed()` for vector similarity
  on the `facts` tier would produce genuine semantic relevance scores. The contract already
  supports this — it is an implementation extension, not a structural change.

- **Disk-backed fact store.** `InMemoryStore` is lost on process exit. A `JsonlFactStore`
  with append-only flush and versioned migrations would give cross-session memory. Design
  the migration format from day one.

- **Dynamic token budget.** `ILLMProvider.turn()` returns `usage.inputTokens`. Feeding this
  back into `ContextBroker` each turn allows the budget to adapt to actual model behaviour
  rather than a fixed constant.

- **Policy confirmation gate.** `PolicyDecision.kind === 'confirm'` is defined in Phase B
  but the confirmation interaction (blocking the loop, awaiting user input, resuming) is a
  Phase F concern. The channel for confirmation responses needs to be designed alongside
  the steering/follow-up queue model.
