# Architecture audit — 2026-09-06

Scope: the current `codex/composable-harness` working tree, including the recent shared execution/context refactor. Three specialist agents independently reviewed API composition, execution/recovery, and context/memory; the primary reviewer examined harness lifecycle. Findings were cross-checked and the specialists challenged their priorities. This is a review, not an implementation pass.

Baseline: all 420 tests pass and TypeScript builds. Small executable reproductions uncovered additional behavior not covered by that suite. No production runtime or deployment was changed by this audit.

## Verdict

Keep the overall direction: small functions/contracts, optional harness, external infrastructure owned by applications such as Gears. The most valuable early changes are fewer authoritative execution and selection paths, truthful types, and explicit effect outcomes. Adding more extension machinery would not address the confirmed problems.

## Fix first: effect correctness and lifecycle

### 1. Unknown tool outcomes lose their meaning — high priority, confirmed defect

`ToolBatchExecutor.ts:271–274` converts explicit `errorKind: 'unknown'` to `runtime_failure`. `harness/host.ts:426` persists that as failed and its uncertainty stop condition only recognizes timeout/cancellation. The shared executor also relies on its consumer to stop after a timeout when the signal was not aborted.

Reproduction: a two-call batch with both tools returning an unknown outcome dispatched both calls and returned two ordinary runtime failures, with no interruption.

Change: preserve explicit uncertainty through the executor, kernel and journal; stop remaining effects centrally. Treat unexpected throws after dispatch conservatively. Tests must assert no subsequent tool or model dispatch. This is a small outcome-contract correction, not a workflow engine.

### 2. Hook failure can erase a successful tool receipt — high priority, confirmed defect

`ToolBatchExecutor.ts:260–268` replaces the tool result if `afterToolCall` throws. A successful external write can consequently be reported as a runtime failure without its successful receipt.

Change: retain the raw result and record hook failure separately. A transformed conversation representation may differ from the raw receipt; it must not rewrite whether the effect occurred. Cover successful and uncertain results with failing hooks.

### 3. Failed activation can leave an active loop running — high priority, confirmed defect

`harness/host.ts:72–81` permits extensions to start work during activation. If a later activation fails, composition directly disposes resources without closing the session client.

Reproduction: the first activation created/submitted a session and waited for its loop to start; a second activation threw. Composition rejected and the store closed, but the running loop's abort signal remained false.

Change: failed activation must stop admission, cancel/drain started work, then unwind resources through the same lifecycle as normal shutdown. Retain exactly-once cleanup. Do not add a dependency-injection framework.

### 4. Pipeline mutation and retry boundaries are surprising — high priority, confirmed defects

`AIPipeline.ts:43–83` returns the same mutable instance cast to new generic types. A retained `IAIPipeline<number>` reference can subsequently return a string after another reference adds a type-changing step.

Transforms, validation and logging wrap the preceding step. Reproduction: `pipe(effect).retry(1).transform(throwingParser)` executed the effect twice because the local parser failed.

Change: immutable pipeline definitions, separate local transformation steps, explicit retry scope. Intentional model regeneration after validation should be an explicit operation. Existing graph retries already require side-effect acknowledgment; replacing that machinery is not a priority.

Also normalize deadline/signal once at pipeline entry. An already-expired `deadline` currently permits a custom pipe step to execute because `AIPipeline.ts:119–145` checks only `signal`.

## Simplify context before extending its API

### 5. The composers disagree about priority and protection — high priority, confirmed inconsistency

`PromptEngine.ts:31–82` selects by phase before priority, protects only explicit sticky sections, trusts estimates and permits sticky overflow. `ContextPipeline.ts:193–229` selects globally, protects constraints, recounts text and rejects protected overflow.

Reproduction: identical task priority 1 / memory priority 100 sections with a budget for one select opposite winners through the two entry points.

Change: one selection policy, one protection rule and one accounting policy. Phase controls rendering position. Keep a section-only adapter where useful; do not create a third selector for builders. Test identical inputs across public entry points.

### 6. History scores grow past explicit section priorities — medium priority, confirmed behavior

`ContextPipeline.ts:207` uses the absolute message-group index as its default score, then compares it with section priorities. A fixed priority changes practical meaning as the conversation grows.

Reproduction: a priority-3 fact survives beside two messages but loses beside eight messages under the same small budget.

Change: one explicit priority, with recency as a tie-break within a priority class. Let retrieval/domain code calculate relevance externally. Remove the public requirement to understand priority × weight × contextMultiplier.

### 7. Budget-aware preparation is missing at consumer boundaries — design gap

`AIPromptService.ts:32–69` concatenates text without context preparation. `AgentLlmNode.ts:188` flattens contributed sections to text, losing their selection metadata. `AgentContextAssembler.ts:50` discards the composition usage/decision report.

Change: a shared preparation result containing the exact request and a separate selection report. Builders expose `context`, `budget` and `prepare`; execution uses the same prepared request. Preserve reports through graph/harness adapters without sending them to providers. Count rendered context, tools/schema overhead and output reserve; an output reserve must correspond to an actual provider output limit. Structured requests currently lack that limit field.

### 8. Memory retrieval duplicates budgeting and violates bounds — medium priority, confirmed defect

`InMemoryStore.ts:55–65` includes an oversized first item and checks the result limit after adding it. `query({limit:0, tokenBudget:0})` can return one item. Its text query is silently ignored, and its token estimate does not describe the final prompt rendering.

Change: strict retrieval limits and honest retrieval capabilities; context preparation owns final prompt budgeting. Remove the memory budget option while alpha, or clearly retain it only as a strict preliminary estimate. A memory contributor is sufficient; no memory orchestration subsystem is needed.

## Make the public contracts truthful

- **Builder output:** `IAIBuilder.ts:15` accepts arbitrary `run<T>()`, while the text path casts a string to T. Plain builders should return string. Structured builders should return unknown unless supplied a parser with an inferred output type; reuse the existing executable-schema concept or a small parser function.
- **Provider capabilities:** `ILLMProvider.embed` is mandatory although Codex and Anthropic implement throwing stubs. Separate an embedding capability. Remove the ignored `model`/`temperature` graph options until they affect a real request. Avoid a capability registry.
- **Recovery resolution:** unknown tools block continuation, but SessionClient has no journaled resolution operation. Its suggestion to fork an earlier safe state is not supported by current `fork(id)`. After fixing certainty, add one revision-checked resolution operation with evidence; automatic reconciliation can wait.
- **Run limits:** expose a small shared limits/options shape instead of hardcoded harness ceilings and divergent entry-point behavior. Context capacity and cumulative run expenditure are different concepts. Hierarchical reservations are premature.
- **Storage growth:** session snapshots contain growing transcripts/operations and are serialized on every commit; list/event reads are unbounded (`harness/stores.ts:132–147`). Add paginated reads and measure long-session behavior before introducing artifact stores or generalized event sourcing.

## Decision on nested builder priorities

Start with named atomic groups. A caller can combine an overview, conventions and examples into one context item with one priority. It is selected or dropped together. Existing tool call/result grouping already demonstrates why atomicity matters.

Suggested API direction, not an implemented API:

```ts
builder
  .contextGroup('project', {
    priority: 80,
    items: [overview, conventions, examples],
  })
  .context(recentNotes, { priority: 30 })
  .budget({ total: 16_000, output: 2_000 })
  .prepare();
```

Do not initially expose arbitrary nesting or child-priority multiplication. Selecting children requires a policy for allocating a budget to the parent; that is additional semantics, not merely convenient syntax. Optional file chunks can remain separate items with common source metadata. Add local child selection only after a concrete consumer demonstrates the need.

## Recommended delivery order

1. Correct effect certainty, preserve raw receipts, and fix activation cleanup. Add focused failure-injection tests.
2. Correct pipeline typing/retry/deadline behavior and builder result types.
3. Unify context selection, simplify scoring, then add budget-aware builders, atomic groups and preparation reports.
4. Add explicit recovery resolution, clean provider capabilities and expose common run limits.
5. Validate these contracts with a minimal Gears consumer and reusable adapter conformance tests. Keep jobs, scheduler and distributed ownership in Gears; keep Assembly's Pi runtime default and Agentic experimental.

Defer recursive context trees, automatic model-driven compression, general dependency-injection/capability registries, and distributed workflow machinery. Each should require demonstrated value from real consumers before entering the library.

## Approved implementation follow-up

The approved core remediation is implemented. See [the migration guide](alpha-api-migration.md) for the final APIs and intentional alpha changes. Validation grew from 420 to 453 tests, with separate strict builder type checks and downstream Assembly/Lean Calendar checks.

The pass fixes effect certainty, raw receipts, activation cleanup, pipeline typing/retry/deadline semantics, context selection and stable priority, builder groups/preparation, memory bounds, provider capability claims, explicit operation resolution and configurable harness limits. Paginated reads are available; full growing snapshots remain. Recursive selection, automatic reconciliation, distributed orchestration and a separate Gears harness remain deliberate future work.
