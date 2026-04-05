# @nucleic-se/agentic — Design Improvements

*Written for the library maintainer. Alpha, breaking changes welcome.*

---

## What the library actually has

Reading all the interfaces before proposing anything:

- `IPromptContributor` / `PromptContributorRegistry` — prompt section composition
- `ICapabilityRegistry` / `CapabilityRegistry` — pack manifest dependency resolution and boot ordering
- `ITickPipeline` / `ITickStep` — ordered step execution with numeric `order`
- `IToolRuntime` / `CompositeToolRuntime` — runtime tool dispatch
- `ITool<TInput, TOutput>` — typed tool with trust tiers, retry, rate limits
- `IToolPolicy` — allow / rewrite / deny / confirm decisions
- `IMemoryStore` / `IFactStore` — typed memory with four tiers, TTL, confidence
- `IAgent` — public agent interface with `prompt()`, `continue()`, history
- `AgentState` — state machine: idle → deliberating → planning → executing → reconciling → done
- `TurnRecord` — rich per-turn record with plan, executions, token usage, outcome
- `IAgentContextAssembler` / `AgentContextAssembler` — assembles system + messages from conversation
- `IContextAssembler` — assembles prompt sections + tool results under a token budget
- `GraphEngineConfig.onBeforeNode` / `onAfterNode` — node-level lifecycle hooks already in the engine
- `SubGraphNode` — nested graph composition already working
- Pattern factories (ReAct, Plan-Execute, Reflection, RAG, CoT, Supervisor-Worker, Human-in-Loop)

This is substantially more complete than it looks from outside. The problems are not missing pieces — they are **fragmentation between pieces that exist but don't connect**.

---

## The five real problems

### 1. `ICapabilityRegistry` is misnamed

The exported `ICapabilityRegistry` / `CapabilityRegistry` manages pack manifests: dependency validation, boot ordering, migration. It has nothing to do with runtime capabilities in the agent sense. The name claims the most valuable semantic slot in the library and uses it for pack plumbing.

**Fix:** Rename to `IPackRegistry` / `PackRegistry`. Free the name `ICapabilityRegistry` for what it should mean: a registry of runtime capabilities that contribute prompt sections, tools, and lifecycle behavior to an agent.

---

### 2. Two disconnected tool systems

`ITool<TInput, TOutput>` and `IToolRuntime` are parallel abstractions that don't compose:

- `ITool` is typed, has trust tiers, retry policies, rate limits, and `execute(input)`
- `IToolRuntime` has `tools(): ToolDefinition[]` and `call(name, args)`
- `IToolPromptRenderer` renders `ToolResult[]` (from `ITool`, with `requestId`, `latencyMs`, `trustTier`) as prompt sections
- `CompositeToolRuntime` uses `IToolRuntime`, not `ITool`
- The pattern factories use `ToolFunction = (input: string) => Promise<string>` — a third form
- `IToolPolicy` exists but `CompositeToolRuntime` doesn't accept one

A developer using the library has to decide which system to use and cannot easily bridge them.

**Fix:** Make `IToolRuntime` the runtime dispatch surface (it already is, keep it). Add:

```typescript
// Adapter: wraps ITool[] as IToolRuntime
class ToolRuntimeAdapter implements IToolRuntime {
  constructor(tools: ITool[], policy?: IToolPolicy) { ... }
  tools(): ToolDefinition[] { ... }
  call(name, args, options?): Promise<ToolCallResult> { ... }
}
```

`CompositeToolRuntime` should accept an optional `IToolPolicy` and evaluate it before dispatching:

```typescript
class CompositeToolRuntime {
  constructor(runtimes: IToolRuntime[], policy?: IToolPolicy) { ... }
}
```

This makes `ITool`, `IToolRuntime`, `IToolPolicy`, and `CompositeToolRuntime` a coherent system instead of three parallel ones.

Deprecate `ToolFunction` in the pattern factories — it's a local shortcut that leaks into the public API.

---

### 3. `IPromptContributor` is isolated from everything else

`IPromptContributor` contributes prompt sections. `IToolRuntime` provides tools. `ITickPipeline` runs ordered steps. These three things are always coupled in practice but have no shared abstraction. A "memory" capability needs all three: a section explaining what memory is available, tools to read and write memory, and a lifecycle step to load memory before the run starts.

The library has `IPackManifest.promptContributors: string[]` — but these are string IDs with no resolution mechanism. There is no way to go from a string ID to a contributor instance.

**Fix:** Introduce `ICapability` as the bundle:

```typescript
interface ICapability<TState extends GraphState = GraphState> {
  readonly id: string;

  // Ordering: this capability's contributions run after the listed IDs
  readonly after?: readonly string[];

  // Activation gate — if absent, always active
  active?(state: Readonly<TState>): boolean;

  // Prompt sections this capability contributes
  readonly prompt?: IPromptContributor;

  // Tool runtime this capability provides
  readonly runtime?: IToolRuntime;

  // Lifecycle hooks
  readonly lifecycle?: ICapabilityLifecycle<TState>;
}

interface ICapabilityLifecycle<TState extends GraphState = GraphState> {
  beforeRun?(state: TState): Promise<void>;
  afterTurn?(state: TState, turn: TurnRecord): Promise<void>;
  afterRun?(state: TState): Promise<void>;
}
```

`ICapability` is a named bundle of existing interfaces — it does not replace them. A capability that only contributes prompt sections sets only `prompt`. A capability that only provides tools sets only `runtime`. The bundle exists so developers register one thing and the registry wires it correctly.

`IPackManifest.promptContributors: string[]` becomes `IPackManifest.capabilities: string[]` — still string IDs, but now resolvable to `ICapability` instances.

---

### 4. `ITickPipeline` and lifecycle hooks solve the same problem differently

`ITickPipeline` runs `ITickStep[]` sorted by numeric `order`. The graph engine has `onBeforeNode`/`onAfterNode` at the node level. There is no agent-level lifecycle hook system that composes across capabilities.

These two things partially overlap:
- `ITickPipeline.run()` is a one-shot ordered step executor — same shape as "run all beforeRun hooks"
- `onBeforeNode`/`onAfterNode` fire per node — too granular for capability lifecycle

**Fix:** Replace numeric `order` in `ITickStep` with ID-based `after` ordering (consistent with `ICapability.after`). The tick pipeline is then the natural implementation mechanism for lifecycle hook ordering in the future capability orchestration layer — an ordered step executor is exactly what dispatching `beforeRun` hooks across capabilities requires.

```typescript
interface ITickStep<TContext extends TickContext = TickContext> {
  id: string;
  after?: string[];   // replaces numeric order
  execute(context: TContext): Promise<void>;
}
```

This also fixes `ITickPipeline` for general use — numeric ordering breaks when steps are registered from different modules that don't coordinate their numbers.

---

### 5. Pattern factories return `IGraphEngine`, not `IAgent`

`createReActAgent`, `createPlanExecuteAgent`, etc. all return `IGraphEngine<TState>`. But the library exports `IAgent` with `prompt()`, `continue()`, `getConversation()`, `getExecutionHistory()` — a proper public interface for interactive use. The two are not connected. There is no way to take a graph built with `StateGraphBuilder` and expose it as an `IAgent`.

**Fix:** Add `AgentRunner` — a class that wraps any `IGraphEngine` (with a graph that has the expected state shape) and implements `IAgent`:

```typescript
interface AgentRunnerConfig<TState extends GraphState> {
  engine: IGraphEngine<TState>;
  // Map from agent-level concepts to graph state keys
  inputKey: keyof TState & string;
  messagesKey: keyof TState & string;
  outputKey: keyof TState & string;
  // Hook dispatch — accepts the capability orchestration layer once it exists (Wave 3)
  lifecycle?: ICapabilityLifecycle<TState>;
}

class AgentRunner<TState extends GraphState> implements IAgent {
  constructor(config: AgentRunnerConfig<TState>) { ... }
  prompt(input: string, sink?: AgentEventSink): Promise<TurnRecord[]> { ... }
  continue(sink?: AgentEventSink): Promise<TurnRecord[]> { ... }
  getConversation(): readonly Message[] { ... }
  getExecutionHistory(): readonly TurnRecord[] { ... }
  clearSession(): void { ... }
}
```

Update pattern factories to return `IAgent` (via `AgentRunner`) instead of `IGraphEngine`. The engine is still accessible for introspection but the public API is `IAgent`.

---

## The capability registry (Wave 3 — shape intentionally deferred)

`IAgentCapabilityRegistry`, `ILifecycleOrchestrator`, and `CompositionReport` belong to Wave 3. Their design is intentionally not settled here.

The registry shape — what methods it exposes, how it orders hooks, what it validates at registration time, what a composition report contains — can only be designed correctly once there are real `ICapability` implementations in the wild to test against. Freezing those details now, before the Wave 2 default capabilities (`PlanningCapability`, `BudgetHintCapability`, `EmptyResponseCapability`) have been built and used, is how you freeze the wrong abstraction.

What is known: the registry will assemble prompt sections, tool runtimes, and lifecycle hooks from registered capabilities, respecting `after` ordering and `active()` gates. Everything else is evidence-dependent.

---

## Two assembler interfaces

`IContextAssembler` and `IAgentContextAssembler` serve genuinely different purposes:

- `IContextAssembler` — takes contributor sections + tool results, assembles a prompt string (token-budget aware)
- `IAgentContextAssembler` — takes a conversation history, produces system + pruned messages

The names don't signal this distinction. Rename:

- `IContextAssembler` → `IPromptAssembler` (it assembles a prompt from sections)
- `IAgentContextAssembler` → `IConversationAssembler` (it assembles a conversation window)

No interface changes — just names that communicate what each thing does.

---

## Memory: connect the store to the prompt

`IMemoryStore` and `IFactStore` exist and are well-designed. The `MemoryType` tiers (`working | episodic | semantic | procedural`) and `MemorySlot` (`user | agent | project`) are the right structure. What's missing is the bridge from store to prompt.

Provide a default `MemoryCapability` that implements `ICapability`:

```typescript
class MemoryCapability<TState extends GraphState> implements ICapability<TState> {
  id = 'memory';

  constructor(private readonly store: IMemoryStore, private readonly facts: IFactStore) {}

  readonly prompt: IPromptContributor = {
    id: 'memory',
    contribute: async (context) => {
      // Query store by context, return sections per memory type
      // Facts go into 'memory' phase as sticky; episodic as non-sticky
    }
  };

  readonly lifecycle: ICapabilityLifecycle<TState> = {
    afterRun: async (state) => {
      // Emit structured memory writes via structured LLM call
      // Store does not write itself — caller decides what to persist
    }
  };
}
```

The design rule from the evolve-lab doc holds: **the agent does not write directly to the memory store**. `afterRun` emits candidates; a separate process decides persistence. The library provides the `MemoryCapability` shell; the storage policy is the application's concern.

---

## Checkpoint: existing infrastructure, explicit contract

`GraphEngineConfig` already has no checkpoint config — but `IGraphEngine` already has `checkpoint()` and `resume()`. The missing piece is a storage contract:

```typescript
interface ICheckpointStore<TState extends GraphState = GraphState> {
  save(checkpoint: GraphCheckpoint<TState>): Promise<void>;
  load(correlationId: string): Promise<GraphCheckpoint<TState> | null>;
  list(correlationId: string): Promise<GraphCheckpoint<TState>[]>;
}
```

Add to `GraphEngineConfig`:

```typescript
interface GraphEngineConfig {
  // ...existing fields...
  checkpointStore?: ICheckpointStore;
  checkpointAfterNode?: string | string[];  // which nodes trigger a checkpoint
}
```

The engine calls `store.save()` after completing the named nodes. `resume()` calls `store.load()`. No marker interface, no assumptions about state serializability — the caller provides a store that knows how to handle its state shape.

---

## Implementation sequencing

Not everything here has the same priority or the same cost to get wrong. The sequencing below reflects that.

---

## Validation from Echo usage

The Echo integration is useful because it exercises the library in a real product shell rather than a toy example. Three framework friction points showed up repeatedly during actual implementation:

1. **API discoverability is still weaker than it should be.**
   The graph and capability primitives are useful, but a cold implementer still benefits too much from external reference notes and example-driven discovery. This validates the Wave 2 focus on making lifecycle contracts explicit and self-documenting.

2. **`graphCtx.reportToolCall()` is a footgun.**
   Having a required manual side effect before dispatch is easy to miss. Echo had to treat this as a checklist item rather than relying on the framework to make the correct behavior obvious. This is strong evidence for moving tool-call accounting closer to the runtime dispatch surface in Wave 1 / Wave 2 work.

3. **Conditional edges are still too stringly typed.**
   Returning raw node IDs from conditional edge callbacks is easy to get wrong and too hard to validate early. Echo's staged runtime refactor made this risk concrete rather than hypothetical. Construction-time validation or stronger typing would remove a real class of errors.

These are not arguments against the library design. They are evidence that the current Wave order is right:

- Wave 1 should connect tool/runtime surfaces and reduce manual dispatch footguns.
- Wave 2 should make lifecycle/capability contracts explicit enough to be discoverable from types.
- Wave 3 should compose those proven pieces rather than papering over ambiguity with a larger orchestration layer.

One important current-state note from Echo integration: much of the Wave 1 surface and the core Wave 2 surface are already present in the library and already being used in Echo. The remaining design pressure is therefore concentrated more heavily in Wave 3 than this document's sequencing language might imply at first read. In practice, the biggest unfinished pieces are:

- an explicit checkpoint storage contract
- runtime resolution of capability `after` ordering
- a real capability composition/registry layer

That does not make the Wave order wrong. It means the later work should be read as "complete and connect the existing pieces cleanly," not "introduce these concepts from zero."

### Wave 1 — Fix the foundation (do first, or alongside runtime defect fixes)

These are concrete, independently valuable, and don't require buying into any new framework layer. Each one ships and works on its own.

| Change | Why now |
|---|---|
| Rename `ICapabilityRegistry` → `IPackRegistry` | Structural, not cosmetic. Leaving the name attached to pack/migration semantics blocks the right abstraction before it starts. Zero behavior change. |
| `ToolRuntimeAdapter` — wraps `ITool[]` as `IToolRuntime` | Bridges the two tool systems. Immediately useful to anyone using `ITool` with `CompositeToolRuntime`. |
| Policy-aware `CompositeToolRuntime` | Adds `IToolPolicy` parameter. Makes the existing policy system actually enforce anything. `IToolPolicy` is currently dead code. |
| `AgentRunner<TState>` | Wraps `IGraphEngine` as `IAgent`. Exposes `.engine` directly so graph-level access (`step()`, `checkpoint()`, `resume()`, `deadLetterQueue`) is not hidden. Update pattern factories to return `AgentRunner`. |
| Grouped conversation assembler | Port `MessageContextManager` from evolve-lab. Replace `AgentContextAssembler`. Fixes the most concrete behavioral defect: naive trimming breaks assistant/tool-result atomicity. Add `toolName?` to `ToolResultMessage` and `sticky?` to `UserMessage`. |
| `ITickStep.order: number` → `after?: string[]` | Numeric ordering breaks cross-module registration. ID-based ordering is the only model that composes correctly across packages. |

Also fix known runtime defects in retry and checkpoint behavior before or alongside this wave. Expanding the abstraction surface over a leaky execution engine is the wrong order.

---

### Wave 2 — Define the capability contract (early, but stay minimal)

Status note:
- the interface shape described here is already largely present in the codebase
- the practical remaining problem is not the existence of `ICapability`
- the practical remaining problem is how capabilities are ordered and composed at runtime

Normalize and complete the exported `ICapability` and `ICapabilityLifecycle` surface once Wave 1 is stable. This gives downstream consumers (and evolve-lab) a contract to build against before the registry exists.

```typescript
interface ICapability<TState extends GraphState = GraphState> {
  readonly id: string;
  readonly after?: readonly string[];
  active?(state: Readonly<TState>): boolean;
  readonly prompt?: IPromptContributor;
  readonly runtime?: IToolRuntime;
  readonly lifecycle?: ICapabilityLifecycle<TState>;
}

interface ICapabilityLifecycle<TState extends GraphState = GraphState> {
  beforeRun?(state: TState): Promise<void>;
  afterTurn?(state: TState, turn: TurnRecord): Promise<void>;
  afterRun?(state: TState): Promise<void>;
}
```

**Scope discipline:** ship this interface and nothing else from the capability system yet. No `produces`/`consumes`, no conflict metadata, no `CompositionReport` shape. Those fields can only be designed correctly once the registry is being built and you know what it actually needs. Freezing them at interface-definition time means freezing them before you have evidence.

Also update `IPackManifest.promptContributors: string[]` → `capabilities: string[]` to align with the new name.

Ship default capability implementations from evolve-lab — `PlanningCapability`, `BudgetHintCapability`, `EmptyResponseCapability` — as concrete uses of the interface that validate it before the registry lands.

---

### Wave 3 — The composition layer (once Wave 1 and 2 are proven)

`IAgentCapabilityRegistry`, `ILifecycleOrchestrator`, the topological sort on `after`, conflict detection, and `CompositionReport`. These are only designable correctly once there are real `ICapability` implementations in the wild to test against.

Also: `ICheckpointStore` and checkpoint config on `GraphEngineConfig`. `MemoryCapability` bridging `IMemoryStore` to prompt sections.

This is now the main remaining structural gap exposed by Echo usage. The library already has many of the pieces Wave 1 and Wave 2 were meant to establish; what it still lacks is the explicit composition layer that makes those pieces work together predictably.

The assembler renames (`IContextAssembler` → `IPromptAssembler`, `IAgentContextAssembler` → `IConversationAssembler`) belong here or later. They have real value for clarity but are not worth spending alpha churn budget on before the behavioral fixes and composition model are stable.

---

## Full change inventory

| Current | Change | Wave |
|---|---|---|
| `ICapabilityRegistry` / `CapabilityRegistry` | Rename to `IPackRegistry` / `PackRegistry` | 1 |
| `CompositeToolRuntime` | Add optional `IToolPolicy` parameter | 1 |
| `ITickStep.order: number` | Change to `after?: string[]` | 1 |
| `AgentContextAssembler` | Replace with grouped two-pass assembler (port from evolve-lab) | 1 |
| `ToolResultMessage` | Add `toolName?: string` | 1 |
| `UserMessage` | Add `sticky?: boolean` | 1 |
| Pattern factories | Return `AgentRunner` (implements `IAgent`, exposes `.engine`) | 1 |
| — | Add `ToolRuntimeAdapter` | 1 |
| — | Add `AgentRunner<TState>` | 1 |
| `IPackManifest.promptContributors` | Rename to `capabilities` | 2 |
| — | Add `ICapability<TState>` | 2 |
| — | Add `ICapabilityLifecycle<TState>` | 2 |
| — | Add `PlanningCapability`, `BudgetHintCapability`, `EmptyResponseCapability` | 2 |
| `IContextAssembler` | Rename to `IPromptAssembler` | 3 |
| `IAgentContextAssembler` | Rename to `IConversationAssembler` | 3 |
| — | Add `IAgentCapabilityRegistry<TState>` | 3 |
| — | Add `ILifecycleOrchestrator<TState>` | 3 |
| — | Add `ICheckpointStore<TState>` + config field | 3 |
| — | Add `MemoryCapability` | 3 |

No existing interface contracts break except `ICapabilityRegistry` rename and `ITickStep.order` → `after`. Both are clean cuts in an alpha library.

---

## Implementation appendix

What a cold agent needs to execute Wave 1 safely, beyond the design above.

---

### Affected files per wave

**Wave 1**

| File | Change |
|---|---|
| `contracts/ICapabilityRegistry.ts` | Rename file and interface to `IPackRegistry` |
| `runtime/CapabilityRegistry.ts` | Rename class to `PackRegistry` |
| `contracts/index.ts` | Export `IPackRegistry` (type only — this barrel is type-only); remove `ICapabilityRegistry` |
| `runtime/index.ts` | Export `PackRegistry` (class); remove `CapabilityRegistry` |
| `index.ts` | Re-export both `IPackRegistry` and `PackRegistry`; remove old names |
| `contracts/llm.ts` | Add `toolName?: string` to `ToolResultMessage`; add `sticky?: boolean` to `UserMessage` |
| `tools/composite.ts` | Add `policy?: IToolPolicy` to constructor; evaluate before dispatch |
| `tools/index.ts` | Add `ToolRuntimeAdapter` export |
| `index.ts` | Add `ToolRuntimeAdapter`, `AgentRunner` exports |
| `runtime/AgentContextAssembler.ts` | Replace implementation with grouped two-pass assembler |
| `contracts/ITickPipeline.ts` | Change `order: number` to `after?: string[]` on `ITickStep` |
| `runtime/TickPipeline.ts` | Replace numeric sort with topological sort; resolve on `run()`, not on `registerStep()` |

**New files — Wave 1**

| File | Contents |
|---|---|
| `tools/adapter.ts` | `ToolRuntimeAdapter` class |
| `runtime/AgentRunner.ts` | `AgentRunner<TState>` class — standalone, not wired to pattern factories in Wave 1 |

**New files — Wave 2**

| File | Contents |
|---|---|
| `contracts/ICapability.ts` | `ICapability<TState>`, `ICapabilityLifecycle<TState>` |
| `runtime/capabilities/PlanningCapability.ts` | Default planning capability |
| `runtime/capabilities/BudgetHintCapability.ts` | Turn-budget warning capability |
| `runtime/capabilities/EmptyResponseCapability.ts` | Empty-response nudge capability |

---

### Wave 1 acceptance criteria

Each item must be independently verifiable before the wave is closed.

**`IPackRegistry` rename**
- `ICapabilityRegistry` and `CapabilityRegistry` are no longer exported from any barrel
- `IPackRegistry` and `PackRegistry` are exported and have identical runtime behavior to the removed names
- All existing `agentic-core.test.ts` capability registry tests pass under the new name

**`ToolRuntimeAdapter`**
- Wraps an `ITool[]` and optionally an `IToolPolicy`
- `tools()` returns a `ToolDefinition[]` derived from each `ITool.inputSchema` and `description`
- `call(name, args)` looks up the `ITool` by name, evaluates policy if present, then calls `tool.execute(args)`
- Policy `deny` → returns `{ ok: false, content: denial reason }` without calling `execute()`
- Policy `rewrite` → calls `execute()` with rewritten args
- Policy `allow` and `confirm` → pass through (confirm treated as allow; interactive confirmation is Wave 3)
- Unknown tool name → returns `{ ok: false, content: 'unknown tool: <name>' }`

**Policy-aware `CompositeToolRuntime`**
- Constructor accepts `runtimes: IToolRuntime[], policy?: IToolPolicy`
- When policy is absent, behavior is identical to current
- When policy is present, `call()` evaluates it before dispatch
- Policy `deny` → returns `{ ok: false, content: reason }` without dispatching
- Policy `rewrite` → substitutes args and dispatches with the rewritten values
- Policy `allow` and `confirm` → pass through (no tracing requirement in Wave 1; observability comes later)

**`AgentRunner`**
- Implements `IAgent`: `prompt()`, `continue()`, `getConversation()`, `getExecutionHistory()`, `clearSession()`
- Exposes `.engine: IGraphEngine<TState>` as a public typed property
- Maintains its own `messages: Message[]` and `history: TurnRecord[]` buffers — these are not read from graph state keys, avoiding the dependency on pattern state shapes
- `prompt(input)` appends a user message to the internal buffer, runs the engine, records the turn, accumulates history
- `continue()` runs the engine from current internal state without appending a new user message
- `getConversation()` returns the internal `Message[]` in chronological order
- `getExecutionHistory()` returns the internal `TurnRecord[]`
- `clearSession()` resets internal buffers; does not mutate the underlying engine
- Pattern factories do **not** change return types in Wave 1 — `AgentRunner` ships as a standalone class for custom graphs; pattern factory migration is deferred until pattern state shapes are updated to support conversation and history storage

**Grouped conversation assembler**
- `buildGroups()`: an assistant message and all immediately following `tool_result` messages whose `toolCallId` matches one of the assistant's `toolCalls[].id` form one atomic group; user messages are self-contained groups
- Groups are never split during compression or dropping
- Two-pass: compress first (lowest-scored groups first), drop only if still over budget after compression pass
- Default `onCompress`: tool-name-aware strategy — `read_file` keeps line-range header and head/tail sample; `search` keeps match lines; `html_query` keeps identifiers; fallback truncates to 400 chars
- Sticky predicate: messages with `sticky === true` are never candidates for compression or drop
- `minRecentGroups`: last N groups are always protected (score set to Infinity)
- `onDrop` callback fires for each dropped message

**`ITickStep` ordering**
- `order: number` removed from `ITickStep`; replaced with `after?: string[]`
- `TickPipeline.registerStep()` allows `after` references to IDs not yet registered — forward references are valid; this is required for cross-module composition where registration order is not coordinated
- Cycle detection and reference resolution happen when `run()` is called, not at registration time; unresolvable or cyclic `after` references throw at `run()` with a descriptive error naming the cycle or missing ID
- `TickPipeline.run()` executes steps in topological order derived from `after` constraints
- Steps with no `after` (or empty `after`) may run in any order relative to each other; registration order is the stable tiebreak within the same topological level
- `listSteps()` returns steps in resolved execution order; throws if called before all referenced IDs are registered (or document that it returns registration order if resolution is deferred to `run()`)

---

### Public export migration

For consumers of the library. Changes affect the main `index.ts` barrel and the subpath barrels (`./contracts`, `./runtime`, `./tools`) exposed in `package.json`. Consumers importing from subpath barrels must update those imports too.

| Before | After | Affected barrels | Kind |
|---|---|---|---|
| `ICapabilityRegistry` | `IPackRegistry` | `index.ts`, `./contracts` | Rename — update imports |
| `CapabilityRegistry` | `PackRegistry` | `index.ts`, `./runtime` | Rename — update imports |
| `ITickStep.order: number` | `ITickStep.after?: string[]` | `index.ts`, `./contracts` | Breaking — replace `order: N` with `after: [...]` |
| `ToolResultMessage` | adds `toolName?: string` | `index.ts`, `./contracts` | Additive — non-breaking |
| `UserMessage` | adds `sticky?: boolean` | `index.ts`, `./contracts` | Additive — non-breaking |
| — | `ToolRuntimeAdapter` | `index.ts`, `./tools` | New export |
| — | `AgentRunner` | `index.ts`, `./runtime` | New export |

Pattern factories do not change return type in Wave 1 — that migration is deferred pending pattern state shape updates.

---

### Tests that must exist before each wave is closed

**Wave 1 — new or updated test coverage required**

- `PackRegistry` (renamed from `CapabilityRegistry`): all existing tests pass under new name; no new behavior
- `ToolRuntimeAdapter`: happy-path dispatch, policy deny, policy rewrite, unknown tool name
- `CompositeToolRuntime` with policy: deny blocks dispatch, rewrite substitutes args, absent policy is identical to current
- `AgentRunner`: `prompt()` runs graph and returns records, `.engine` is accessible, `clearSession()` resets internal buffers, `getConversation()` accumulates messages from internal buffer (not from graph state), pattern factories are not changed
- Grouped assembler: groups never split, compress pass fires before drop pass, sticky messages survive, `minRecentGroups` protects tail, `onDrop` called for dropped messages, tool-name-aware default compression
- `TickPipeline` with `after`: forward references allowed at registration, cycle detection throws at `run()` not at `registerStep()`, topological execution order, stable tiebreak for same-level steps

**Wave 2 — new test coverage required**

- `ICapability` interface: a minimal implementation passes type-checking with only `id` set
- `PlanningCapability`: `beforeRun` calls `provider.structured()`, writes to `stateKey`, falls back gracefully on error
- `BudgetHintCapability`: hint injected at correct thresholds, hint messages are sticky, no hint below threshold
- `EmptyResponseCapability`: nudge injected on empty turn, mid-run vs wrap-up message selected by recent history, counter resets on non-empty turn, done set after max retries

---

## What to lift from evolve-lab

Evolve-lab built several pieces on top of the library that belong in the library itself. Each has been running in production against real workloads, so the design is not speculative.

---

### 1. `MessageContextManager` → replace `AgentContextAssembler`

The current `AgentContextAssembler` trims conversation history with a simple `minRecentMessages` count. Evolve-lab's `MessageContextManager` does substantially more and should replace it as the default `IConversationAssembler` implementation.

**The core insight that must be preserved: atomic grouping.**

An assistant message and all the tool results that follow it are an atomic unit. You cannot drop a `tool_result` without its assistant message, and dropping an assistant message while keeping its tool results leaves the conversation in an incoherent state. The library's current assembler has no concept of this.

```typescript
// buildGroups — internal algorithm the new assembler must implement
// Groups: { messages: Message[], firstIndex: number, score: number, tokens: number, dropped: boolean }
// An assistant message + all immediately following tool_results with matching toolCallIds = one group
// User messages = self-contained groups
```

**The two-pass strategy:**

1. **Compress pass** — for each candidate group (lowest-scored first), call `onCompress` on each message. If the group shrinks in tokens, use the compressed version and keep it in context.
2. **Drop pass** — if still over budget, drop candidate groups entirely (lowest-scored first).

Compress before drop. This preserves more of the conversation history and avoids the cliff where suddenly large chunks vanish.

**Configuration surface to carry over:**

```typescript
interface ConversationAssemblerConfig {
  tokenBudget: number;
  minRecentGroups?: number;      // always protect last N groups regardless of score
  scorer?(msg: Message, index: number): number;   // higher = survives; default: recency
  sticky?(msg: Message, index: number): boolean;  // never drop; default: first message
  onCompress?(msg: Message): Promise<Message | null>;  // return compressed or null
  onDrop?(msg: Message): void;
}
```

**Also fix `ToolResultMessage`:** evolve-lab attaches `toolName` to tool result messages so the compressor can apply tool-specific strategies. The library's `ToolResultMessage` interface is missing this field:

```typescript
// Current
interface ToolResultMessage {
  role: 'tool_result';
  toolCallId: string;
  content: string;
  isError?: boolean;
}

// Add toolName
interface ToolResultMessage {
  role: 'tool_result';
  toolCallId: string;
  toolName?: string;   // add this
  content: string;
  isError?: boolean;
}
```

---

### 2. Tool-name-aware compression as the default `onCompress`

Evolve-lab's `compressToolResult` function shows what a practical default compression strategy looks like. The naive default (truncate to N chars) loses too much structure. Tool-specific strategies preserve what matters:

- **`read_file`**: keep the line-range header and a head/tail sample of numbered lines. Elide the middle. The agent can re-read if needed.
- **`search`**: keep match lines (marked with `▶`), drop context lines. The match is the signal; the surrounding context is noise once compressed.
- **`html_query`**: keep element identifiers and line numbers, drop content values. Structure survives; bulk is gone.
- **Short results (≤300 tokens)**: keep as-is regardless of tool name.
- **Default fallback**: keep first 400 chars with a truncation marker.

This should be the library's default `onCompress` — not a truncation function, but a `toolName`-dispatching strategy. Callers can override for their own tool names.

---

### 3. `PlanningCapability` — structured pre-flight as a default capability

Evolve-lab's `runPlanningStep` uses `provider.structured()` in the `initialize` node to do a cheap typed call before the main agentic loop. It decides *what* to do before the expensive loop starts. The mechanism is general; only the schema is evolve-lab-specific.

Lift it as a `PlanningCapability<TSchema, TState>`:

```typescript
class PlanningCapability<TSchema, TState extends GraphState> implements ICapability<TState> {
  readonly id = 'planning';

  constructor(private readonly config: {
    provider: ILLMProvider;
    system: string;
    prompt(state: Readonly<TState>): string;
    schema: JsonSchema;
    stateKey: keyof TState & string;   // where to write the plan in state
    fallback?: TSchema;                // returned if structured() fails; null disables planning
  }) {}

  readonly lifecycle: ICapabilityLifecycle<TState> = {
    beforeRun: async (state) => {
      try {
        const result = await this.config.provider.structured({
          system: this.config.system,
          messages: [{ role: 'user', content: this.config.prompt(state) }],
          schema: this.config.schema,
        });
        state[this.config.stateKey] = result.value as TState[typeof this.config.config.stateKey];
      } catch {
        // Planning is best-effort — fall back gracefully
        if (this.config.fallback !== undefined) {
          state[this.config.stateKey] = this.config.fallback as TState[typeof this.config.config.stateKey];
        }
      }
    }
  };
}
```

Key design decisions from the evolve-lab implementation to preserve:
- Planning is **best-effort**: if `structured()` throws (provider doesn't support it, network error), fall back gracefully rather than failing the run.
- Planning reads from state (e.g., a loaded memory file) so the `prompt` function is a state projection, not a static string.
- The result seeds state; the agent loop reads it from there.

---

### 4. `BudgetHintCapability` — tiered turn-budget warnings

Evolve-lab injects user messages into the conversation when the agent approaches its turn limit. This prevents the common failure mode where the agent keeps making tool calls until it hits the wall and produces no final output.

The three-tier system from the implementation:

| Threshold | Message intent |
|---|---|
| ≥ 75% turns used | "Start planning your wrap-up" |
| ≥ 90% turns used | "Begin wrapping up, write summary soon" |
| Final turn | "No more tool calls — write final output now" |

Lift as `BudgetHintCapability`:

```typescript
class BudgetHintCapability<TState extends GraphState> implements ICapability<TState> {
  readonly id = 'budget-hint';

  constructor(private readonly config: {
    maxTurns: number;
    turnCountKey: keyof TState & string;
    messagesKey: keyof TState & string;
    thresholds?: Array<{ pct: number; message: string }>;  // override defaults
  }) {}

  readonly lifecycle: ICapabilityLifecycle<TState> = {
    afterTurn: async (state) => {
      const turn = state[this.config.turnCountKey] as number;
      const pct = turn / this.config.maxTurns;
      const remaining = this.config.maxTurns - turn;
      // inject hint message at threshold, mark as sticky
    }
  };
}
```

The sticky marking is important: hint messages must survive context pruning or they disappear from the agent's view exactly when they matter most.

---

### 5. `EmptyResponseCapability` — nudge and retry on empty turns

When the agent returns an empty response (no content, no tool calls), evolve-lab injects a context-aware nudge and retries up to `MAX_EMPTY_RETRIES` times before giving up. The nudge message varies based on recent history:

- If recent messages include tool results → agent is mid-task: "continue, use a tool or write your next step"
- If no recent tool results → agent is wrapping up: "write your final output now, no tool calls needed"

Lift as `EmptyResponseCapability`:

```typescript
class EmptyResponseCapability<TState extends GraphState> implements ICapability<TState> {
  readonly id = 'empty-response';

  constructor(private readonly config: {
    maxRetries?: number;           // default 2
    maxTurns: number;
    turnCountKey: keyof TState & string;
    messagesKey: keyof TState & string;
    emptyCountKey: keyof TState & string;
    doneKey: keyof TState & string;
    nudgeMidRun?: string;
    nudgeFinal?: string;
  }) {}

  readonly lifecycle: ICapabilityLifecycle<TState> = {
    afterTurn: async (state, turn) => {
      if (turn has content or tool calls) return;  // not an empty turn
      // increment counter, inject nudge if under limit, set done if over limit
    }
  };
}
```

The context-awareness (checking recent messages for tool results) is a detail worth preserving — "you forgot to respond" and "please wrap up now" are meaningfully different messages.

---

### 6. Formalize the sticky message convention

Evolve-lab uses `_sticky: true` as a custom property on messages to mark them as surviving context pruning. Budget hints, empty-response nudges, and planning seeds all use this. It is an informal convention today; it should be part of the message contract.

The cleanest form: a `sticky` flag on `UserMessage` specifically (system-injected hints are always user-role messages):

```typescript
interface UserMessage {
  role: 'user';
  content: string;
  provenance?: MessageProvenance;
  sticky?: boolean;   // add this — never dropped by conversation assembler
}
```

The conversation assembler's `sticky` predicate then has a sensible default: `msg.sticky === true`. Callers can extend it but most will not need to.

---

### What not to lift

| Evolve-lab code | Reason to leave behind |
|---|---|
| `WorkspaceToolRuntime` | Evolve-lab specific workspace management |
| `FileToolRuntime` | Library already has `FsToolRuntime` |
| Planning schema (`improvement`/`section`/`approach`) | Evolve-lab specific; the `PlanningCapability` takes a generic schema |
| `initialUserMessage` | Evolve-lab specific run framing |
| `composeSystemPrompt` | Replaced entirely by `IAgentCapabilityRegistry` |
| NDJSON log format | Library already has `ITracer` and structured `AgentEvent` |
