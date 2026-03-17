# CodingAgent — Demo

A stateful coding agent built on `@nucleic-se/agentic` primitives.

This is a reference implementation — showing how the library's primitives compose into a
production-grade agent rather than a toy loop. Read the code, copy the patterns.

---

## What it is

A multi-turn, tool-calling agent that:

- Drives execution through an **explicit state machine** (idle → deliberating → planning →
  executing → reconciling → done/failed)
- Keeps **three separate stores**: what was said (conversation), what happened
  (execution records), and what the model sees (context)
- **Plans before executing** — tool calls are a plan produced by the model; the runtime
  validates, executes, and reconciles it explicitly
- Has a **formal policy layer** that evaluates every tool call before it runs
- Uses a **ContextBroker** to select and budget what gets sent to the model each turn
- Records a **`TurnRecord`** for every turn — full debug/replay fidelity, always
- Treats **failures as first-class** — every error category has an explicit recovery policy

---

## Quick start — Phase A (minimal)

```ts
import { createCodingAgent, createCodingTools } from './demo/agent/index.js'
import { AnthropicProvider }                    from './providers/index.js'
import type { IModelRouter }                    from './contracts/llm.js'

const provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! })
const router: IModelRouter = { select: () => provider }

const agent = createCodingAgent({
  router,
  tools:        createCodingTools({ cwd: process.cwd() }),
  systemPrompt: 'You are a coding assistant. Read files before editing them.',
})

const records = await agent.prompt('What does the entry point do?', (event) => {
  if (event.type === 'message_end') process.stdout.write(event.message.content + '\n')
  if (event.type === 'tool_end')    console.log(`  ${event.name} → ${event.execution.status}`)
})

console.log(`Completed in ${records.length} turn(s)`)
```

---

## Architecture overview

### The three stores

Every agent implementation is tempted to use a single `messages` array as the source of
truth. That's the wrong abstraction. Three things are happening at once, and they are not
projectable from each other:

| Store | What it contains | Owner | Used by |
|---|---|---|---|
| **Conversation** | `Message[]` — the LLM-visible dialogue | `CodingAgent` | Provider `.turn()` call |
| **Execution** | `TurnRecord[]` — what actually happened | `CodingAgent` | Debugging, replay, summarisation |
| **Context** | Assembled system + selected sections | `ContextBroker` (Phase C) | The model's actual view each turn |

### The state machine

```
idle
  │  user calls prompt() or continue()
  ▼
deliberating ──── LLM call fails ────► failed
  │
  ▼  model responds
planning ──── stopReason=max_tokens ──► failed (partial)
  │
  ├── stopReason=end_turn ──► done  (or loop back via follow-up messages)
  │
  ▼  stopReason=tool_use
executing ──── AbortSignal ──► aborted
  │              ↕ steering interrupt → reconcile early
  ▼
reconciling
  │  commit TurnRecord, append messages
  ▼
idle  (loop for next turn, or done if no more work)
```

### The turn record

`TurnRecord` is the canonical debug object. Generated for every turn, regardless of outcome.

```ts
{
  turnId, userInput,
  modelRequest,    // exactly what was sent to the provider
  modelResponse,   // exactly what came back
  plan,            // all tool calls the model intended
  executions,      // what actually ran (may be partial if interrupted)
  outcome,         // 'answered' | 'partial' | 'terminated' | 'failed' | 'aborted' | 'interrupted'
  failure?,        // if outcome is failed/aborted/partial
  interrupted?,    // set when steering/abort broke mid-execution
  durationMs, tokenUsage,
  contextUsed?,    // what ContextBroker selected (Phase C+)
}
```

### The policy layer (Phase B)

Every tool call passes through `ToolPolicy.evaluate()` before it executes. The policy
returns one of: `allow` / `rewrite` (modify args) / `deny` (skip with synthetic error) /
`confirm` (Phase F: pause for user).

`DefaultToolPolicy` uses `IToolRegistry` trust tiers: `trusted` and `standard` tools are
allowed; `untrusted` tools (fetch, external APIs) are allowed but the result is normalised
into an `ExternalArtifact` with content clipping and an `containsInstructions` flag.

Policy is for runtime enforcement. `beforeToolCall` (Phase F) is for extensibility hooks.
They are not the same thing.

### The context broker (Phase C)

Replaces "pass all messages every turn" with principled selection and rendering.

Two responsibilities kept separate by design:

1. **Selection** — score candidates on three axes (recency, relevance, authority) and pick
   what fits
2. **Rendering** — pass `PromptSection[]` to `IPromptEngine.compose()` for hard token budget
   enforcement

`IPromptEngine` is the safety net, not the selector. If you only use `IPromptEngine` without
the broker, you get budget enforcement but not intelligent selection.

### Turn summaries (Phase C)

After every turn, a `TurnSummary` is generated (fast LLM tier):

```ts
{ turnId, userIntent, toolsUsed, filesRead, filesModified, keyFindings,
  unresolvedItems, outcome, tokenEstimate }
```

The last 3 turns stay raw in context. Older turns are represented by their summary.
`SessionFileTracker` ensures the model always knows what files it has touched, even when
all summaries are dropped by budget pressure.

### Memory (Phase E)

Two product-level concepts, not four tiers up front:

- **Scratchpad** — session-scoped, mutable, no policy. For active task state.
- **Facts** — provenance-backed, policy-gated. For durable knowledge across turns.

Both are backed by `IMemoryStore`. `FactExtractor` runs post-turn using
`ILLMProvider.structured()` on the fast tier.

---

## Phases at a glance

| Phase | What you can do after it | Key new concept |
|---|---|---|
| **A** — Execution kernel | Full multi-turn tool-calling; per-turn `TurnRecord`; state machine; failure taxonomy | Three stores, plan-as-history model |
| **B** — Policy & trust | Trust-tier enforcement; deny/rewrite tool calls; typed external artifacts | `ToolPolicy`, `ExternalArtifact` |
| **C** — Context broker | Principled context selection; turn summaries; token budget enforcement | `ContextBroker`, `TurnSummary`, 3-axis scoring |
| **D** — Observability | Hierarchical span tracing; context decision debug traces | `ISpanTracer` span hierarchy |
| **E** — Memory | Scratchpad and facts that survive across turns; write policy | `FactStore`, `FactExtractor` |
| **F** — Extensions | Full hook surface; ITickPipeline lifecycle; three-layer message model; pluggable ops | `BeforeToolCallContext`, `AgentMessage`, `BashOperations` |

Build phases in order. Each phase assumes correctness from the previous. Memory (E) is last
because it multiplies every pre-existing mistake.

---

## Files

```
contracts/agent.ts             Shared types: AgentState, TurnRecord, ToolPlan, ToolExecution,
                               Failure, AgentEvent, IAgent, AgentConfig — no demo/ imports

demo/agent/
  README.md                    This file
  implementation_plan.md       Full design document — types, pseudocode, rationale, open questions

  ── Phase A ───────────────────────────────────────────────────────────
  kernel.ts                    deliberate / plan / execute / reconcile (pure function)
  CodingAgent.ts               Stateful wrapper; owns three stores; implements IAgent
  tools.ts                     createCodingTools() — fs_read, fs_write, shell_exec, fetch, search
  index.ts                     Barrel: createCodingAgent()

  ── Phase B ───────────────────────────────────────────────────────────
  tool-policy.ts               DefaultToolPolicy (uses IToolPolicy from library)
  artifact.ts                  ExternalArtifact — typed untrusted content

  ── Phase C ───────────────────────────────────────────────────────────
  context-broker.ts            ContextBroker — 3-axis selection + IPromptEngine rendering
  turn-summarizer.ts           TurnSummary, summarizeTurn()
  session-file-tracker.ts      Cumulative read/write path tracking across budget trims

  ── Phase D ───────────────────────────────────────────────────────────
  (ISpanTracer wired additively — no new files)

  ── Phase E ───────────────────────────────────────────────────────────
  fact-store.ts                FactStore: scratchpad + facts + write policy
  fact-extractor.ts            Post-turn structured extraction into FactStore

  ── Phase F ───────────────────────────────────────────────────────────
  turn-pipeline.ts             ITickPipeline: pre/post-turn lifecycle steps
  agent-message.ts             AgentMessage layer + toLlmMessages()
  tool-operations.ts           BashOperations, FsOperations — pluggable execution interfaces
  config-loader.ts             3-level config resolution (.agent/settings.json)
  system-prompt-builder.ts     Modular system prompt + cross-tool guidelines
```

---

## Failure handling

Every failure category has an explicit recovery policy defined in the implementation plan.
No silent swallowing, no generic catch-and-continue.

| What failed | Loop continues? | `TurnOutcome` |
|---|---|---|
| LLM transport error (`llm_transport_error`) | No — terminal | `'failed'` |
| LLM protocol error (`llm_protocol_error`) | No — terminal | `'failed'` |
| Policy denial (`tool_validation_error`) | Yes — synthetic result, next call proceeds | per-execution |
| Tool runtime error (`tool_runtime_error`) | Yes — error result passed to model | per-execution |
| Tool timeout (`tool_timeout`) | Yes — treated as runtime failure | per-execution |
| Max turns exceeded | No — terminal | `'terminated'` |
| `stopReason === 'max_tokens'` | No — terminal | `'partial'` |
| `AbortSignal` fired | No — terminal | `'aborted'` |
| Steering interruption | Yes — loop restarts with steering messages | `'interrupted'` |
| Context assembly failed | No — terminal; fires before `turn_start` | not appended |
| Memory read/write failed | No — degraded, continues | no TurnRecord impact |
| Unknown exception | No — terminal | `'failed'` |

`agent_end` fires in `finally` — always, unconditionally. `context_error` is the one
category that fires before `turn_start` and therefore has no `TurnRecord`; all other
failure categories record a `TurnRecord` regardless of outcome.

---

## Documentation

| Doc | What it covers |
|---|---|
| [`implementation_plan.md`](./implementation_plan.md) | Full design: type signatures, kernel pseudocode, 3-axis scoring, memory write policy, hook ordering, ITickPipeline step table, open questions |
| [`docs/three-stores.md`](./docs/three-stores.md) | Why conversation / execution / context are three separate stores, and what breaks if you collapse them |
| [`docs/context-broker.md`](./docs/context-broker.md) | How the broker scores and selects context candidates; how `IPromptEngine` enforces the hard budget; turn summaries and file tracking |
| [`docs/failure-model.md`](./docs/failure-model.md) | Every failure category with cause, recovery policy, rationale, and `TurnRecord` outcome |
