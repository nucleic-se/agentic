# Evolution Report: `@nucleic/agentic`

## Insights from Agent Tangent Research & Recommendations for Improvement

_Generated 2026-02-18_

---

## Executive Summary

The `agent_tangent` corpus represents a comprehensive body of research on orchestrated LLM architectures — covering orchestration patterns, memory design, evaluation harnesses, security posture, observability, failure playbooks, and maturity models. This report maps those insights against the current state of `@nucleic/agentic` to identify concrete evolution paths.

**Current state:** `@nucleic/agentic` provides clean, composable primitives — prompt engine, state graph, tick pipeline, capability registry, and seven pre-built agentic patterns. It has excellent contract/runtime separation and zero domain opinions.

**Key gap theme:** The library excels at _composition_ but lacks the _orchestration infrastructure_ that `agent_tangent` identifies as essential for production-grade agentic systems — specifically around memory, trust/provenance, evaluation, observability, and failure resilience.

---

## 1. The Orchestrator Gap

### Insight (agent_tangent)

> "The orchestrator is the compiler. The language model is the runtime."

The core thesis is that LLMs are stateless inference engines. All apparent intelligence — memory, planning, tool use — comes from an external orchestration layer that curates context, mediates tools, enforces policy, and manages state. The orchestrator follows a 10-state control flow: `INIT → RETRIEVE_CONTEXT → ASSEMBLE_PROMPT → PLAN → EXECUTE → VERIFY → RESPOND → MEMORY_UPDATE → LOG → ERROR`.

### Current State

`@nucleic/agentic` has the building blocks (prompt engine, graph engine, tick pipeline) but no first-class orchestrator that ties them together with this control flow. The graph engine could model this flow, but the states for context retrieval, verification, and memory update have no corresponding abstractions.

### Recommendations

- **R1.1 — Context Assembly Pipeline.** Formalize a `ContextAssembler` that composes prompt sections in the canonical order: system constraints → developer instructions → memory → tool outputs → conversation history → user message. The `PromptEngine` already scores and budgets sections — layer a structured assembly step on top that enforces ordering semantics and hard-pins critical constraints (never dropped under budget pressure).

- **R1.2 — Verification Step.** Add a `VerificationNode` or pattern that cross-checks claims against tool outputs and memory before producing a final response. The `agent_tangent` research emphasizes: _high-impact claims require evidence_. This could be a callback graph node that inspects state for unsupported assertions.

- **R1.3 — Orchestrator State Machine Template.** Provide a pre-built graph template (similar to patterns) implementing the 10-state orchestrator control flow. Users can opt in to the states they need — minimally `INIT → ASSEMBLE → EXECUTE → RESPOND`, expanding to include `PLAN`, `VERIFY`, and `MEMORY_UPDATE` as maturity increases.

---

## 2. Memory Architecture

### Insight (agent_tangent)

Memory is categorized into four types:

| Type | Purpose | TTL |
|------|---------|-----|
| **Working** | Session-scoped task state | Minutes–hours |
| **Episodic** | Event/decision summaries | Weeks–months (decayed) |
| **Semantic** | Stable facts/preferences | Months–years (versioned) |
| **Procedural** | Policies and playbooks | Versioned with prompts |

Key principles: memory must be _curated_ (small, high-signal), _explainable_ (provenance, timestamp, confidence), _correctable_ (edits, rollbacks), _safe_ (no secrets), and _time-aware_ (TTL + decay). The LLM may only _propose_ memory writes — the orchestrator validates and commits.

### Current State

`@nucleic/agentic` has **no memory abstraction**. State exists within graph execution (`GraphState`) and tick pipelines (`TickContext`), but there's no persistent, cross-session memory with retrieval, decay, or governance.

### Recommendations

- **R2.1 — Memory Contracts.** Define `IMemoryStore` with the four memory types. Each memory item should carry: `id`, `type`, `key`, `value`, `created_at`, `updated_at`, `ttl_days`, `confidence`, `source`, `sensitivity`, `tags`, `supersedes`, `history[]`. Keep this as a pure contract in `contracts/`.

- **R2.2 — Memory Retrieval Interface.** Define `IMemoryRetriever` that accepts a query context (message embedding, task type, safety level) and a budget (max items, max tokens), and returns ranked items using a composite score of relevance, recency, confidence, and diversity penalty.

- **R2.3 — Memory Write Governance.** Memory writes must flow through a deterministic validation path: schema check → deduplication/merge → timestamp → sensitivity classification → optional user confirmation → commit with version bump. The LLM proposes; the orchestrator disposes. Expose this as `IMemoryWriteValidator`.

- **R2.4 — Memory Prompt Contributor.** Create a built-in `PromptContributor` that injects curated memory into the assembled prompt using the labeled format recommended by `agent_tangent`:
  ```
  [MEMORY — CURATED]
  Semantic:
  - response_style: concise (user_confirmed, 2026-02-18, confidence: 0.95)
  Episodic:
  - "Decided on TypeScript + Postgres stack" (2026-01-15)
  Note: Memory may be stale; explicit user instructions in this turn take precedence.
  ```

- **R2.5 — Memory Poisoning Defenses.** Never store instructions from untrusted sources. Never store tool outputs verbatim as memory. Require user confirmation for preference changes implied by adversarial content.

---

## 3. Tool System Hardening

### Insight (agent_tangent)

Tools are governed by strict rules:
- Tool outputs are **untrusted data** by default
- Every output must carry provenance: `tool_name`, `timestamp`, `request_id`, `status`, `latency_ms`, `source`, `trust_tier`
- Tools must be narrow, single-purpose, with strong schemas
- Rate limits, quotas, circuit breakers, and bounded retries are non-negotiable
- The LLM never calls tools directly — the orchestrator mediates

### Current State

The `ToolFunction` type in patterns is `(input: string) => Promise<string>` — untyped string-in/string-out with no schema, no provenance, no trust tier, no rate limiting.

### Recommendations

- **R3.1 — Typed Tool Registry.** Replace the string-based `ToolFunction` with a structured `ITool` contract:
  ```typescript
  interface ITool<TInput = unknown, TOutput = unknown> {
    name: string;
    description: string;
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
    trustTier: 'verified' | 'standard' | 'untrusted';
    rateLimit?: { maxCallsPerTurn: number; maxCallsPerSession: number };
    timeout_ms?: number;
    retryPolicy?: { maxRetries: number; backoffMs: number };
    execute(input: TInput): Promise<TOutput>;
  }
  ```

- **R3.2 — Tool Output Provenance.** Wrap every tool result in a `ToolResult` envelope carrying `toolName`, `timestamp`, `requestId`, `status`, `latencyMs`, `trustTier`, and the actual `data`. Inject into prompts under an explicit `[UNTRUSTED DATA]` label.

- **R3.3 — Tool Mediation Layer.** Add an orchestrator-level `ToolMediator` that validates args against schema, applies rate limits, executes with timeout, normalizes output, attaches provenance, and rejects calls that violate policy — before injecting results back into the graph state.

- **R3.4 — Circuit Breakers.** Implement circuit breaker state per tool: after N consecutive failures, skip the tool and degrade gracefully. Expose this as configurable policy on the tool registry.

---

## 4. Observability & Tracing

### Insight (agent_tangent)

Every turn must log: `request_id`, `session_id`, `prompt_version`, `model_version`, `assembled_prompt_hash`, `tool_calls` (with params/status/latency), `safety_decisions`, and full metrics (token counts, cost). The principle: _"if you can't reproduce a turn from logs, you can't debug it."_

Recommended dashboards: tool error rates, avg tool calls per turn, latency percentiles, safety block rates, hallucination proxy rates.

### Current State

`InMemoryTracer` provides flat `TraceEvent` objects in a ring buffer, queryable by `correlationId`. No spans, no hierarchy, no persistence, no export format, no structured querying, no log levels.

### Recommendations

- **R4.1 — Span-Based Tracing.** Evolve `TraceEvent` into hierarchical spans: a top-level turn span containing child spans for context assembly, each tool call, LLM inference, verification, and memory update. Each span carries `startTime`, `endTime`, `status`, `metadata`.

- **R4.2 — Structured Turn Log.** Define a `TurnLog` aggregate that captures the full assembled prompt (or hash), all tool calls with provenance, the model response, safety decisions, token counts, and cost estimate. This is the reproducibility artifact.

- **R4.3 — Tracer Export.** Add export adapters — at minimum JSON serialization. Consider alignment with OpenTelemetry span format for ecosystem compatibility.

- **R4.4 — Configurable Correlation.** The `correlationId` is currently hardcoded to `'graph'` in the graph engine. Make it configurable per `run()` call and propagate through all child operations.

- **R4.5 — Metrics Collection.** Track and expose: tool error rate by tool, average tool calls per turn, latency p50/p95, token usage per turn, and cost estimates. These can be computed from span data.

---

## 5. Failure Resilience

### Insight (agent_tangent)

Eight catalogued failure patterns:

| ID | Failure | Core Fix |
|----|---------|----------|
| F1 | Hallucinated Facts | Evidence requirements, tool grounding, allow "unknown" |
| F2 | Context Drop | Hard-pin critical sections, must-include validation |
| F3 | Tool Misuse | Narrow tools, selection hints, retry backoff |
| F4 | Untrusted Output as Truth | Provenance, trust tiers, cross-checking |
| F5 | Prompt Injection | Treat tool output as data, sanitize instruction-like text |
| F6 | Plan-Execution Drift | Structured plan schema, step-by-step enforcement |
| F7 | Infinite Loops | Max-steps, circuit breakers, degrade gracefully |
| F8 | Memory Poisoning | TTL, user confirmation, conflict resolution |

### Current State

The graph engine has `maxSteps` (F7) and dead letter queue for node errors. But there's no node-level retry, no circuit breakers, no plan validation, no prompt injection defense, and no hard-pinning of critical prompt sections.

### Recommendations

- **R5.1 — Node-Level Retry with Backoff.** Allow `IGraphNode` to declare a retry policy. On failure, the engine retries with exponential backoff up to `maxRetries`, then routes to DLQ or error handler. This directly addresses F3 (tool misuse recovery).

- **R5.2 — Sticky Section Enforcement.** The `PromptEngine` already supports `sticky` sections (never trimmed). Formalize this as the mechanism for hard-pinning safety constraints and system instructions. Add validation that sticky sections are always present in the composed output. This addresses F2 (context drop).

- **R5.3 — Plan Validation Hook.** In the Plan-Execute pattern, add an external plan validator that checks the generated plan against policy constraints before execution begins. Reject impossible, unsafe, or out-of-scope steps. This addresses F6 (plan-execution drift).

- **R5.4 — Graceful Degradation Paths.** When a tool fails permanently (circuit breaker open) or context is insufficient, degrade to a clarification question rather than hallucinating. Provide a `DegradationStrategy` contract: `'retry' | 'fallback' | 'clarify' | 'abort'`.

- **R5.5 — Termination Guarantees.** Enforce hard caps across the orchestration: max tool calls per turn, max total latency per turn, max total tokens across all model calls in a turn. Expose as `OrchestratorLimits` configuration.

---

## 6. Evaluation Infrastructure

### Insight (agent_tangent)

> "The evaluation harness is infrastructure, not a test script."

Five test categories: correctness, tool use, memory discipline, safety/policy, robustness. Tests should evaluate the _system_ (orchestrator + memory + tools + model), not just the model. Regression suites from production incidents are mandatory and never deleted. CI gates should fail on safety score 0, average drops, tool misuse, and latency/cost regressions.

### Current State

Tests cover unit-level behavior of primitives and patterns using mock LLMs. No integration evaluation harness, no regression suite structure, no scoring model, no CI-ready evaluation pipeline.

### Recommendations

- **R6.1 — Evaluation Test Case Schema.** Define a standard test case format:
  ```typescript
  interface EvalTestCase {
    id: string;
    category: 'correctness' | 'safety' | 'tool_use' | 'memory' | 'robustness';
    input: { userMessage: string; memory?: MemoryItem[]; tools?: string[]; contextOverrides?: Record<string, unknown> };
    expected: { mustInclude?: string[]; mustNotInclude?: string[]; toolExpectations?: ToolExpectation[]; minScore?: number };
  }
  ```

- **R6.2 — Scoring Model.** Implement the 0–3 scoring rubric: 0 = fail/unsafe, 1 = partially correct, 2 = correct but weak grounding, 3 = correct + grounded + robust. Aggregate as mean score, failure rate by category, and critical failure count.

- **R6.3 — Regression Suite Contract.** Provide a `RegressionSuite` runner that accepts test cases, executes them against the full system, scores results, and reports pass/fail with detailed diffs. After any production incident: create reproducing test case → add to suite → never remove.

- **R6.4 — Version Pinning.** Every evaluation run should capture: prompt version, model version, tool versions, retrieval config, and policy version. This enables reproducibility and diff analysis.

---

## 7. Prompt Engineering Improvements

### Insight (agent_tangent)

Prompts are code — version them, diff them, test them. Structure beats prose. Context ordering matters: earlier tokens exert stronger influence. Ten canonical prompt templates are defined for different orchestration phases.

### Current State

The `PromptEngine` scores and budgets sections. `PromptContributors` produce sections from context. The `AIPromptBuilder` provides a fluent API for `system()` + `user()` messages. But there's no ordering semantics beyond score, no prompt versioning, no template library.

### Recommendations

- **R7.1 — Section Ordering Semantics.** Add an explicit `order` or `phase` property to `PromptSection` that determines position in the assembled prompt independent of score. Phases could mirror the agent_tangent ordering: `constraint → task → memory → tools → history → user`. Score then determines inclusion within a phase under budget pressure.

- **R7.2 — Prompt Versioning.** Attach a `version` string to prompt configurations. Log the version with every turn for reproducibility. This is a metadata concern, not a runtime concern — lightweight to implement.

- **R7.3 — Canonical Templates.** Provide template factories for common prompt sections: system constraints, task framing, memory injection, tool catalog, verification instructions, clarification requests, and error/degradation messages. These encode the structural best practices from `agent_tangent` without prescribing content.

- **R7.4 — Assistant Message Role.** Add `assistant()` to `IAIPromptBuilder` for multi-turn conversation support. The current builder only supports `system` + `user`, which limits conversational patterns.

---

## 8. Security Posture

### Insight (agent_tangent)

Core rule: _"Never let untrusted content become instructions."_ This requires instruction/data separation in prompts, sanitization of tool outputs (strip instruction-like patterns), allowlist parsing (extract only needed fields from external data), schema hardening (strict types, enums, reject out-of-range), and least-privilege tool access.

### Current State

No explicit security layer. Tool outputs flow directly into graph state without sanitization or trust labeling. No instruction/data separation in prompt assembly.

### Recommendations

- **R8.1 — Trust Tier Labeling.** Categorize all inputs by trust level: system constraints (trusted), developer instructions (trusted), memory (trusted but stale), user messages (untrusted), tool outputs (untrusted unless marked). Prompt assembly should label untrusted sections explicitly.

- **R8.2 — Output Sanitization.** Add a `sanitize()` step in tool output processing that strips instruction-like patterns ("ignore previous instructions", "system prompt:", "you are now...") from untrusted data before injection into prompts.

- **R8.3 — Allowlist Parsing.** When extracting data from external sources (web pages, APIs), extract only the needed fields via structured parsing (JSON schema validation) rather than injecting raw text.

- **R8.4 — Scope-Based Tool Access.** Tools should declare required auth scopes. The orchestrator gates tool access based on the current session's permissions. Read-only tools should be separated from write-capable tools with different authorization levels.

---

## 9. Maturity Model Alignment

### Insight (agent_tangent)

Six maturity levels, each with specific requirements and risks:

```
L0: Stateless Assistant → L1: Tool-Using → L2: Memory-Surfaced →
L3: Planner-Executor → L4: Verify-First → L5: Multi-Agent
```

**Cardinal rule:** Do not skip levels. Most production failures come from adopting higher-level patterns without meeting the prerequisites of earlier levels.

### Current State

`@nucleic/agentic` provides patterns spanning L0 through L5 (CoT, ReAct, Plan-Execute, Supervisor-Worker, Human-in-Loop), but the underlying infrastructure only fully supports L0–L1. The gap is the missing orchestration, memory, verification, and governance layers.

### Recommendations

- **R9.1 — Maturity Gates.** Document the prerequisites for each pattern and validate them at construction time. For example, `createPlanExecuteAgent` should warn (or require) that a verification step is configured. `createSupervisorAgent` should require observability and cost controls.

- **R9.2 — Progressive Enhancement Path.** Structure the library so users can start at L0 (prompt engine + LLM provider) and progressively add capabilities: tool registry (L1) → memory store (L2) → plan validation (L3) → verification nodes (L4) → multi-agent coordination (L5). Each level adds contracts and runtime components without breaking lower levels.

- **R9.3 — Maturity Documentation.** Document what each level requires, what risks it introduces, and what mitigations must be in place. Reference the `agent_tangent` maturity model directly.

---

## 10. Graph Engine Enhancements

### Insight (agent_tangent)

Agents are distributed systems requiring: parallel execution, checkpoint/resume, time bounds, and structured error handling. The orchestrator state machine requires async routing decisions and configurable correlation for tracing.

### Current State

The graph engine is well-built but sequential-only, with read-only snapshots, synchronous-only routing, hardcoded tracer correlation, and no node-level timeout or retry.

### Recommendations

- **R10.1 — Async Routing.** Make `RouterFn` async to support routing decisions that require database lookups, LLM calls, or external service checks.

- **R10.2 — Node Timeout.** Add an optional `timeout_ms` to `IGraphNode`. The engine should abort node execution and route to error handling if the timeout is exceeded.

- **R10.3 — Checkpoint/Resume.** Evolve snapshots into rehydratable checkpoints. Serialize the graph execution state (current node, step count, full state clone) so execution can resume from a checkpoint after interruption or across process boundaries.

- **R10.4 — Parallel Node Execution.** Add a `parallel` edge type that fans out to multiple nodes and joins results. This enables parallel tool calls (critical for latency) and parallel worker delegation in the supervisor pattern.

- **R10.5 — Graph Visualization.** Export graph topology to Mermaid or DOT format for debugging and documentation. This is a quality-of-life enhancement that becomes essential as graphs grow complex.

---

## Priority Ranking

Based on impact and the maturity model's "don't skip levels" principle:

| Priority | Recommendation | Rationale |
|----------|---------------|-----------|
| **P0** | R3.1 Typed Tool Registry | Foundation for L1 maturity — current string-based tools are a blocker |
| **P0** | R3.2 Tool Output Provenance | Untrusted data must be labeled; prerequisite for security and verification |
| **P0** | R4.4 Configurable Correlation | Low-effort fix with high debugging value |
| **P1** | R2.1 Memory Contracts | Foundation for L2 maturity — enables memory-surfaced agents |
| **P1** | R5.1 Node-Level Retry | Basic resilience for tool-using patterns |
| **P1** | R7.1 Section Ordering | Structure beats score alone for prompt assembly |
| **P1** | R10.1 Async Routing | Unblocks real-world routing patterns |
| **P2** | R1.1 Context Assembly Pipeline | Formalizes the orchestrator's core responsibility |
| **P2** | R2.2 Memory Retrieval | Enables intelligent memory surfacing |
| **P2** | R3.3 Tool Mediation Layer | Centralizes tool governance |
| **P2** | R4.1 Span-Based Tracing | Production observability |
| **P2** | R8.1 Trust Tier Labeling | Security foundation |
| **P3** | R1.3 Orchestrator Template | Reference implementation of the full control flow |
| **P3** | R5.5 Termination Guarantees | Production safety net |
| **P3** | R6.1 Eval Test Case Schema | Evaluation infrastructure |
| **P3** | R10.3 Checkpoint/Resume | Long-running agent support |
| **P3** | R10.4 Parallel Execution | Latency optimization |

---

## Guiding Principles (from agent_tangent)

These should inform all evolution work:

1. **The LLM is never the system.** It's a stateless reasoning component inside a larger control architecture.
2. **Structure beats cleverness.** Explicit labeled sections, schemas, and structured data outperform raw prose.
3. **Memory is a liability if unmanaged.** Curated, time-bounded, auditable, and correctable.
4. **Tools are untrusted by default.** Every output gets provenance and trust-tier labeling.
5. **Evaluation is infrastructure.** Regression suites, CI gates, scoring rubrics — not optional.
6. **Determinism wraps creativity.** The orchestrator is deterministic; only the LLM does creative work.
7. **Logs are the foundation.** If you can't reproduce a turn from logs, you can't debug or trust it.
8. **Maturity is earned.** Progress through levels sequentially. Skipping gates causes failures.
9. **Prompts are code.** Version, diff, test, and roll back with the same rigor as source code.
10. **Fail gracefully.** Bounded retries, circuit breakers, degradation to clarification — prevent runaway behavior.

---

## Conclusion

`@nucleic/agentic` has a strong compositional foundation — clean contracts, generic primitives, and well-tested patterns. The evolution path is to layer orchestration concerns _around_ these primitives rather than replacing them. The priority sequence is: **harden tools (L1) → add memory (L2) → formalize orchestration (L3) → add verification (L4) → enable coordination (L5)**, with observability and security threading through every level.

The `agent_tangent` research provides both the architectural blueprint and the operational playbooks. The work ahead is implementation — one maturity level at a time.
