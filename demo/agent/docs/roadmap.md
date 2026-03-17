# Maturity Roadmap

This document describes how `demo/agent` can evolve from a clear alpha
reference implementation into a production-grade agent runtime.

The goal is not to add features indiscriminately. The goal is to preserve the
current architectural strengths:

- explicit turn records
- explicit state-machine thinking
- clear separation between conversation, execution, and context
- policy-aware tool execution
- composable runtime primitives

The path forward is to harden those strengths, close correctness gaps, and add
the missing operational layers around them.

---

## What "mature" means

A mature agent runtime should have the following properties:

1. **Correct by default**
   Context budgets are enforced reliably, protocol invariants always hold, and
   failure paths are explicit and testable.

2. **Durable across long sessions**
   The agent can survive long-running work without context collapse, silent data
   loss, or opaque summarisation behaviour.

3. **Auditable**
   The system can explain what it sent to the model, what the model planned,
   what actually executed, what was denied, and why.

4. **Extensible without patching the core**
   New tools, policies, prompts, memory backends, storage backends, and runtime
   hooks can be added through stable interfaces.

5. **Operationally usable**
   The runtime supports persistence, replay, diagnostics, and clear recovery
   from failure.

6. **Tested at the behavioural level**
   The main guarantees are enforced by executable tests, not only by design
   documents.

---

## Current strengths

The current implementation already has the right foundation in several areas:

- a coherent execution kernel with explicit turn boundaries
- `TurnRecord` as a first-class debug and replay object
- a strong failure taxonomy
- separation between policy, tool runtime, context assembly, and stateful agent
  wrapper
- a principled direction for context selection and memory

These should be preserved. The roadmap below assumes they are the core design
assets of the project.

---

## Current gaps

The main missing pieces are not conceptual. They are maturity gaps:

- correctness gaps in boundary conditions
- no dedicated behavioural test suite for `demo/agent`
- no durable session persistence or replay tooling
- no clear storage model for summaries, facts, or execution history
- no explicit data lifecycle policy for persisted sessions, artifacts, and
  memory
- context management is promising but not yet fully closed under real budget
  pressure
- provider differences are not yet treated as a first-class compatibility
  concern
- model-specific tool-calling weaknesses are not yet handled systematically
- security and isolation concerns are only partially covered through tool policy
- observability exists in outline, but not yet as a full operator workflow
- performance and cost controls are not yet explicit
- configuration scope and migration are still underdefined
- CLI/runtime ergonomics are still minimal

---

## Guiding principles

The roadmap should follow these rules:

1. **Correctness before features**
   A feature that weakens replay fidelity, budget safety, or protocol integrity
   is regression, not progress.

2. **Execution truth stays authoritative**
   Summaries, facts, and derived context are useful, but `TurnRecord` remains
   the source of truth.

3. **Add durable storage deliberately**
   Persistence should be designed around explicit schemas and migration paths,
   not scattered file writes.

4. **Make every layer independently testable**
   Kernel, context broker, persistence, summarisation, memory, and policy
   should each have focused tests.

5. **Keep the core small**
   Product/runtime features should sit on top of the kernel rather than being
   baked into it wherever possible.

6. **Treat compatibility and safety as design concerns**
   Provider differences, model quirks, sandbox boundaries, data handling, and
   persistence rules should be designed explicitly rather than handled as
   incidental edge-cases.

---

## Execution Tracks

The roadmap is organized into a small number of execution tracks. Each track is
large enough to be meaningful and small enough to sequence.

### 1. Runtime Correctness And Compatibility

This is the first priority. The runtime should not expand feature scope until
the existing model is closed under its own invariants.

Core concerns:

- context budget correctness
- exact request/response recording
- protocol invariants
- interruption and failure semantics
- provider compatibility
- model-agnostic tool-calling behaviour

Required work:

- enforce end-to-end context budgets, including raw tail messages
- ensure `TurnRecord.modelRequest` matches the actual provider request exactly
- make summarisation and fact extraction lifecycle ordering correct and explicit
- add defensive handling for hook failures, malformed tool plans, and partial
  provider outputs
- define provider-facing compatibility expectations
- normalize provider-specific quirks at the provider boundary
- add explicit handling for weak tool-calling models:
  batching instructions, structured-output scaffolding, fallback parsing, and
  model-specific prompt adapters where necessary

This track should answer:

- Is the runtime correct under all documented failure paths?
- Can supported providers be used without leaking quirks into the kernel?
- Can weaker models still be made reliable enough to participate?

Exit criteria:

- no known mismatch between assembled context and actual model input
- no known mismatch between recorded request/response and actual request/response
- supported providers satisfy explicit contract expectations
- model-specific tool-calling behaviour is handled intentionally rather than by
  prompt folklore

### 2. Behavioural Tests And Dogfooding

`demo/agent` needs its own test suite before it needs a formal evaluation
harness.

Test categories to add:

- kernel turn-loop tests
- policy decision tests
- steering and follow-up tests
- abort and interruption tests
- context broker selection and budget tests
- summarisation and memory lifecycle tests
- artifact normalisation tests
- tracing/event ordering tests

Dogfooding scenarios to add early:

- representative coding/exploration tasks
- tasks involving multiple file reads in one turn
- interrupted tool execution with steering
- long-session context pressure scenarios
- external/untrusted content handling

Important principle:

- test the contracts, not only the implementation details

Exit criteria:

- `demo/agent` has dedicated tests for its core guarantees
- major documented invariants are backed by executable assertions
- there is a small, repeatable set of representative tasks used for regression
  checking during development

### 3. Persistence, Memory, And Data Lifecycle

The runtime needs a durable session layer around the kernel, and that layer must
have explicit data-lifecycle rules from the start.

What to add:

- persistent session storage for conversation, turn records, summaries, and
  memory items
- explicit session schema and versioning
- append-only or replay-safe storage format
- separation between transient runtime state and persisted session state
- durable memory backends for facts and scratchpad
- provenance on writes
- retention, export, deletion, and rebuild rules for persisted data

Recommended model:

- persist raw execution truth first
- persist derived artifacts separately
- make derived artifacts rebuildable from execution history where possible

This track should answer:

- How do we resume an interrupted session?
- How do we inspect or replay a historical turn?
- What is raw truth versus derived state?
- How can stored data be migrated, exported, rebuilt, or deleted?

Exit criteria:

- a session can be resumed from disk with execution history intact
- stored state has an explicit migration story
- replay and inspection do not depend on ephemeral process memory
- facts and scratchpad survive process restarts
- persisted data classes have explicit lifecycle semantics

### 4. Tools, Policy, And Security

The current tool layer is clean, but still narrow. Policy also needs to mature
into a broader runtime safety system.

Maturity work:

- stronger tool metadata and capability descriptors
- explicit destructive-tool confirmation flows
- per-tool timeout and concurrency policies
- richer trust-tier handling for external and generated artifacts
- better artifact provenance, clipping, and storage of full content
- typed execution interfaces for shell and filesystem operations
- clear filesystem, process, and network boundary model
- secret-handling policy for prompts, logs, and tool outputs
- redaction controls for persisted traces and debug exports

The policy layer should eventually provide:

- allow / deny / rewrite / confirm
- budget and rate limits
- path/domain allowlists
- structured audit trail for policy decisions

Exit criteria:

- tools can be governed centrally by runtime policy
- external/untrusted results are handled safely and traceably
- execution boundaries are explicit and enforceable
- sensitive data handling is documented and testable

### 5. Context, Observability, Performance, And Evaluation

The context broker is one of the best ideas in the current architecture. It
should become complete, measurable, and cheap enough to operate continuously.

Work to complete:

- unify all context inputs under a single measured token budget
- distinguish selected candidates from actually included candidates
- expose broker decisions in debug output
- add richer candidate types:
  active files, unresolved work items, recent failures, policy denials
- make lane rules configurable without weakening defaults
- add stronger relevance strategies beyond keyword matching when embeddings are
  available
- add debug export of full run state
- add per-turn inspection CLI or JSON export
- add context-decision, policy-decision, and latency traces
- add explicit token-cost accounting for summaries, memory extraction, and
  broker overhead
- add performance benchmarks for long sessions and multi-tool turns
- after the runtime is durable, add a formal evaluation harness and regression
  corpus

The broker and surrounding operator tooling should eventually provide:

- deterministic assembly
- token accounting
- explanation of why something was included or dropped
- stable behaviour under long sessions
- measurable cost and latency impact

Exit criteria:

- context assembly is explainable and measurable
- budget enforcement is reliable for all included material
- a failed run can be reconstructed from persisted data
- major runtime costs are measurable and bounded
- a formal evaluation harness exists once the runtime is stable enough to make
  it worthwhile

### 6. Extensibility, Config, And Operator UX

The existing hooks are useful, but they are still low-level. The runtime also
needs a clear configuration model and a workable operator surface.

The next step is to define a stable runtime extension surface:

- lifecycle hooks with clear ordering and guarantees
- pluggable session storage
- pluggable summary and fact extraction strategies
- pluggable prompt/system prompt builders
- pluggable confirmation channels
- pluggable tool operation backends
- explicit config scopes: global, project, session, and runtime override
- deterministic precedence rules
- config schema versioning and migration
- persistent session commands
- inspect/history/replay commands
- model selection and configuration loading
- clearer progress and failure output

Good rule:

- core runtime owns correctness
- extensions own customization

Exit criteria:

- common customizations can be implemented without patching core files
- hook semantics are documented and tested
- configuration behaviour is predictable and migratable
- a user can start, resume, inspect, and debug sessions without modifying code

---

## Suggested phases

### Phase 1: Alpha Hardening

Focus:

- runtime correctness and compatibility
- behavioural tests
- early dogfooding scenarios
- broker budget closure
- request/record fidelity
- event and interruption invariants

Outcome:

- trustworthy alpha for iterative development

### Phase 2: Durable Runtime

Focus:

- persistent sessions
- durable summaries and memory
- data lifecycle rules
- replay/debug export
- migration-aware storage

Outcome:

- sessions survive process boundaries and can be inspected

### Phase 3: Operational Beta

Focus:

- stronger policy system
- security and isolation model
- richer observability
- context explainability
- performance and cost controls
- CLI/session ergonomics

Outcome:

- usable by real operators on longer tasks

### Phase 4: Stable Platform

Focus:

- stable runtime extension contracts
- pluggable backends
- stable configuration model
- documented public API
- versioning and compatibility discipline
- formal evaluation harness

Outcome:

- production-grade runtime with a clear customization model

---

## Phase 1 Punch List

This is the concrete implementation punch list for the next stage. The items are
ordered by dependency and tagged with rough effort.

1. Fix end-to-end context budgeting so raw tail messages count toward the same
   budget as rendered sections. Effort: medium.

2. Fix `TurnRecord.modelRequest` fidelity so it records the actual transformed
   message set sent to the provider. Effort: small.

3. Fix post-turn lifecycle ordering for summarisation and fact extraction so the
   current turn is handled at the correct point in session state. Effort: small.

4. Add kernel contract tests for success, `max_tokens`, transport failure,
   protocol failure, abort, and steering interruption. Effort: medium.

5. Add conversation append invariants tests:
   every tool call gets a result, appends are atomic, interrupted turns remain
   protocol-valid. Effort: medium.

6. Add broker tests for token accounting, tail selection, summary inclusion, and
   candidate selection metadata. Effort: medium.

7. Add provider contract fixtures for turn, stream, and structured-output
   behaviour using mocked providers. Effort: medium.

8. Add a model-adaptation layer for weak tool-using models:
   prompt shaping, batching emphasis, and structured-output fallback handling.
   Effort: medium.

9. Add a small set of repeatable dogfood tasks that are run during development
   to catch obvious regressions in tool use and context handling. Effort: small.

10. Add debug export for a single run containing:
    turn records, assembled context, policy decisions, and tool executions.
    Effort: medium.

11. Add explicit error handling around hook failures and malformed tool plans so
    they degrade into named failure paths instead of escaping as generic
    exceptions. Effort: medium.

12. Document supported provider assumptions and known degraded paths. Effort:
    small.

If sequencing must stay especially tight, the highest-leverage subset is:

1. context budget fix
2. request fidelity fix
3. lifecycle ordering fix
4. kernel contract tests
5. broker tests
6. provider fixtures
7. dogfood tasks

---

## Recommended implementation order

If sequencing must stay tight, the highest-leverage order is:

1. runtime correctness and compatibility
2. behavioural tests and dogfooding
3. persistence, memory, and data lifecycle
4. tools, policy, and security
5. context, observability, performance, and later evaluation
6. extensibility, config, and operator UX

This order minimizes the risk of building features on top of unstable
foundations.

---

## Open design questions

These are unresolved decisions that will affect future implementation. Noted here
so they inform design work rather than being rediscovered.

- **Embedding-based retrieval.** `FactStore` and `ContextBroker` currently use
  keyword overlap for relevance scoring. Using `ILLMProvider.embed()` for vector
  similarity on the facts tier would produce genuine semantic relevance. The
  contract already supports this — it is an implementation extension, not a
  structural change.

- **Disk-backed fact store.** `InMemoryStore` is lost on process exit. A
  `JsonlFactStore` with append-only flush and versioned migrations would give
  cross-session memory. The migration format should be designed from day one,
  not retrofitted.

- **Dynamic token budget.** `ILLMProvider.turn()` returns `usage.inputTokens`.
  Feeding this back into `ContextBroker` each turn allows the budget to adapt to
  actual model behaviour rather than a fixed constant — useful for models that
  count tokens differently than the estimator assumes.

---

## Non-goals

The runtime should avoid these traps:

- overloading the kernel with product-specific concerns
- treating summaries as truth
- adding many hooks before defining their guarantees
- building UI-first features before persistence and replay exist
- solving every future use case in the first stable API
- using prompt tweaks as a substitute for explicit compatibility handling

---

## Definition of "ready for stable use"

`demo/agent` is ready to graduate from alpha when all of the following are true:

- the documented invariants are enforced by tests
- supported providers satisfy explicit contract expectations
- model-specific tool-calling weaknesses are handled intentionally
- sessions are durable and replayable
- data retention and deletion rules are explicit
- context assembly is budget-safe in practice, not only in design
- memory and summaries are inspectable and policy-controlled
- tool execution and policy decisions are auditable
- execution boundaries and sensitive-data handling are explicit
- the extension surface is intentional and documented
- configuration behaviour is deterministic and migratable
- major runtime costs are measurable and bounded
- failures are diagnosable without ad hoc instrumentation

Until then, the right posture is:

- keep the architecture explicit
- optimize for correctness and inspectability
- add operational layers in measured steps

That path preserves what is already good about the current design while making
it substantially more robust over time.
