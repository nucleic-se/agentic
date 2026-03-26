# From Decent to Excellent

## Purpose

This report describes how to move `agentic` from a good set of agent primitives to an excellent substrate for building reliable autonomous systems.

"Decent" means the library already has useful abstractions and a coherent architecture.
"Excellent" means the primitives are hard to misuse, operationally reliable, and capable of supporting multiple downstream agents without each consumer having to reinvent safety, recovery, and execution discipline.

The difference is not mostly about adding features. It is about turning informal expectations into enforced guarantees.

## Current Strengths

`agentic` already has several properties worth preserving:

- Clear separation between graph execution, tools, providers, prompts, and policy.
- A compact conceptual surface area that is still understandable end to end.
- A graph-oriented runtime model rather than a single opaque loop.
- Checkpointing and structured tool interfaces, which are the right foundations for durable agents.
- Enough modularity that downstream systems like Ivy and Aveline can compose different execution shells on top.

These are real strengths. The path to excellence should preserve this simplicity instead of burying it under configuration.

## The Real Gap

The main gap is not capability. The main gap is enforceability.

Today, `agentic` exposes several contracts that are useful in principle, but too many of them are advisory rather than guaranteed. This creates a predictable failure mode:

- the primitive looks correct in isolation,
- the downstream app adds metadata or conventions,
- the runtime does not actually enforce them,
- the system becomes easy to misuse in subtle ways.

An excellent primitive layer closes that gap.

## Definition of Excellent

`agentic` should be considered excellent when it satisfies most of the following:

- Safe compositions are the default.
- Dangerous compositions require explicit opt-in.
- Runtime semantics are consistent across apps.
- Recovery behavior is reliable and testable.
- Tool execution is deterministic enough to reason about.
- Cancellation, timeout, and retry behavior are first-class runtime concepts.
- Observability is structured, not improvised.
- Consumers do not need to reimplement execution policy in every downstream agent.

## Priority 1: Make the Runtime Hard to Misuse

This is the highest-leverage improvement.

### 1. Enforce execution semantics in the runtime

Tool metadata should not be decorative. If a tool is marked non-parallel-safe, the runtime must serialize it. If a tool is path-scoped, the runtime must detect collisions and refuse or sequence conflicting calls.

Recommended additions:

- Add first-class tool execution metadata to the shared contract.
- Support at least these execution modes:
  - `read_only`
  - `path_scoped_write`
  - `exclusive_process`
  - `external_side_effect`
- Make the executor plan a batch rather than blindly `Promise.all()` every call.
- Expose the execution plan in traces so behavior is inspectable.

This turns safety from convention into mechanism.

### 2. Separate tool policy from tool scheduling

Policy answers "should this be allowed?"
Scheduling answers "how should this run?"

Those should be distinct runtime layers.

Recommended design:

- `IToolPolicy`: allow, deny, confirm.
- `IToolScheduler` or equivalent execution planner: serial, parallel, conflict-aware grouping.
- `IToolRuntime`: pure dispatch.

That separation will keep downstream agents from encoding scheduling assumptions in policy code.

### 3. Promote side effects to explicit types

Right now, many tool calls are just name-plus-args. That is not enough for reliable orchestration.

Add metadata such as:

- mutating vs read-only
- local vs external side effect
- idempotent vs non-idempotent
- cancellable vs non-cancellable
- resumable vs non-resumable

The engine should use these properties for:

- parallelization decisions
- retry rules
- resume behavior
- cancellation semantics
- audit reporting

## Priority 2: Make Cancellation Real

A contract-level `AbortSignal` is useful, but it only matters if the engine actually drives it.

An excellent system needs coherent cancellation semantics:

- A cancelled run stops requesting more model turns.
- In-flight tools receive cancellation when possible.
- Non-cancellable tools are marked as such and handled explicitly.
- Final run state is deterministic after cancellation.
- Observability distinguishes `cancelled` from `failed`.

Recommended work:

- Add a run-scoped cancellation controller to the graph engine.
- Thread the signal into every node and tool call.
- Define cancellation checkpoints: before LLM call, before tool dispatch, after batch completion.
- Add tests for cancellation during:
  - model call
  - tool execution
  - reconcile/checkpoint
  - multi-turn loops

This is one of the clearest divides between a prototype substrate and a professional one.

## Priority 3: Strengthen Recovery Guarantees

Checkpointing exists, but excellence requires stronger semantics around what checkpointing means.

Questions the runtime should answer clearly:

- What state is guaranteed durable after each turn?
- What happens if a crash occurs during tool execution?
- Can a run resume after partially completed side effects?
- How are duplicate side effects prevented after restart?

Recommended improvements:

- Define a formal run lifecycle with durable transitions.
- Distinguish checkpoints that are safe to resume from those that are informational only.
- Add an optional idempotency token per tool call.
- Persist tool execution intent and outcome in a structured ledger.
- Support "resume only from safe boundary" semantics.

For tools with non-idempotent effects, resume should be conservative by default.

## Priority 4: Improve Observability as a Primitive

Excellent agent infrastructure needs better answers to these questions:

- What exactly happened?
- In what order?
- Why did the runtime make that decision?
- Which side effects occurred?
- Which part consumed time and tokens?

Recommended observability model:

- Stable event schema for run, turn, node, tool, policy, scheduler, and checkpoint events.
- Correlation IDs that are consistent across resume boundaries.
- Structured outcome classification:
  - answered
  - aborted
  - failed
  - cancelled
  - policy_denied
  - timed_out
- Explicit event emission for scheduler decisions:
  - ran in parallel
  - serialized due to exclusive tool
  - serialized due to path conflict
  - retry suppressed due to non-idempotent effect

The goal is to make postmortems cheap.

## Priority 5: Tighten the Downstream Integration Surface

A primitive library becomes excellent when downstream apps are guided into correct usage.

That means reducing the amount of application-specific glue needed for core runtime behavior.

Recommended improvements:

- Ship a canonical execution runtime that already handles:
  - policy
  - scheduling
  - cancellation
  - normalization
  - tracing
- Provide a small number of opinionated extension points instead of many soft contracts.
- Create reference integrations that downstream agents can adopt with minimal divergence.
- Add compatibility tests using one or two real consumer configurations.

If Ivy and Aveline both need to solve the same runtime problem separately, `agentic` is still too low-level in the wrong places.

## Priority 6: Make the Contracts Smaller and Sharper

A great primitive layer is not the one with the most interfaces. It is the one where each interface has a crisp responsibility.

Good questions to ask:

- Which contracts are essential?
- Which are convenience abstractions?
- Which are leaking runtime assumptions upward?

Likely improvements:

- Consolidate overlapping tool/runtime/registry responsibilities.
- Move execution metadata closer to tool definitions.
- Prefer one well-defined runtime lifecycle over many ad hoc hooks.
- Reserve escape hatches for advanced users, but keep them explicitly advanced.

The simplest architecture that enforces the right invariants is the target.

## Priority 7: Raise the Test Bar

To become excellent, the project needs more misuse-oriented and systems-oriented tests, not just happy-path tests.

Add focused suites for:

- conflicting writes in one tool batch
- non-parallel-safe tool batches
- cancellation during long-running tools
- resume after crash between tool execution and checkpoint persistence
- duplicate execution prevention on restart
- policy plus scheduler interactions
- partial tool failures inside a mixed batch
- external-side-effect tools under retry pressure

Also add contract tests for downstream consumers:

- a consumer should be able to plug in a tool runtime and get predictable execution semantics without custom patches
- a consumer should not be able to accidentally bypass safety metadata silently

## Practical Roadmap

### Phase 1: Close the obvious correctness gaps

- Standardize tool names and execution metadata across the stack.
- Enforce parallel-safety rules in the executor.
- Wire cancellation from engine to tools.
- Add regression tests for these behaviors.

This is the fastest path from decent to solid.

### Phase 2: Make recovery and observability trustworthy

- Introduce structured tool execution ledgering.
- Define safe resume boundaries.
- Improve event schemas and outcome taxonomy.
- Add crash/restart tests.

This is the path from solid to reliable.

### Phase 3: Ship a canonical high-discipline runtime

- Provide a reference runtime that downstream agents can use directly.
- Minimize per-app reimplementation of policy, scheduling, and tracing.
- Publish one or two recommended integration modes instead of many implicit ones.

This is the path from reliable to excellent.

## Design Principle to Keep

Do not try to become excellent by becoming large.

The codebase is valuable partly because it is still legible. The right move is not to add every enterprise feature. The right move is to enforce a small number of critical invariants at the primitive layer:

- tool execution semantics are real
- cancellation is real
- recovery boundaries are real
- traces are real
- unsafe compositions are explicit

If those become true, `agentic` will stop being merely a useful toolkit and start becoming a trustworthy substrate.

## Final Verdict

`agentic` does not need a conceptual reinvention.
It needs a reliability pass that turns advisory abstractions into runtime guarantees.

That is very achievable.

The important thing is to treat excellence here as a systems property, not a feature checklist.
