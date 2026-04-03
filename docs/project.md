# Project Tracker

## Review Findings

| ID | Status | Severity | Area | Summary |
|---|---|---|---|---|
| R1 | Fixed | High | Graph runtime | `AgentLlmNode` retry logic computes a fallback provider but never uses it, so failover does not work. |
| R2 | Fixed | High | Graph runtime | `StateGraphEngine` checkpoint/resume does not preserve elapsed wall-clock time, so `maxTotalMs` can be bypassed across resumes. |
| R3 | Fixed | High | Graph runtime | Parallel branch retries reuse mutated branch state instead of restoring the original branch snapshot. |
| R4 | Fixed | Medium | Provider | `OllamaProvider.structured()` forwards library message roles directly and can emit invalid wire-format roles for tool-result history. |

## Details

### R1: AgentLlmNode failover retry does not switch provider

- Status: Fixed
- Severity: High
- Impact: Error-cascade and model-tier fallback behavior is documented but ineffective. Retries keep hitting the original failed provider.
- Evidence:
  - [runtime/graph/nodes/AgentLlmNode.ts#L158](/Users/david/Coding/nucleic/agentic/runtime/graph/nodes/AgentLlmNode.ts#L158)
  - [runtime/graph/nodes/AgentLlmNode.ts#L189](/Users/david/Coding/nucleic/agentic/runtime/graph/nodes/AgentLlmNode.ts#L189)
  - [runtime/graph/nodes/AgentLlmNode.ts#L215](/Users/david/Coding/nucleic/agentic/runtime/graph/nodes/AgentLlmNode.ts#L215)
- Notes:
  - The code resolves `retryProvider` after `onError`, but the loop continues using the original `provider` variable.
  - Writing `__provider` onto the request has no effect because no code reads it.

### R2: Checkpoint/resume does not preserve elapsed wall-clock budget

- Status: Fixed
- Severity: High
- Impact: Runs can exceed a hard `maxTotalMs` limit by checkpointing and resuming.
- Evidence:
  - [contracts/graph/IGraphEngine.ts#L234](/Users/david/Coding/nucleic/agentic/contracts/graph/IGraphEngine.ts#L234)
  - [runtime/graph/StateGraphEngine.ts#L268](/Users/david/Coding/nucleic/agentic/runtime/graph/StateGraphEngine.ts#L268)
  - [runtime/graph/StateGraphEngine.ts#L301](/Users/david/Coding/nucleic/agentic/runtime/graph/StateGraphEngine.ts#L301)
- Notes:
  - `GraphCheckpoint` includes `elapsedMs`, but `checkpoint()` never populates it.
  - `resume()` restarts timing from `Date.now()` instead of continuing from stored elapsed time.

### R3: Parallel branch retries do not restore pre-branch state

- Status: Fixed
- Severity: High
- Impact: A retried parallel branch can observe partially mutated state from its failed prior attempt, breaking retry isolation.
- Evidence:
  - [runtime/graph/StateGraphEngine.ts#L351](/Users/david/Coding/nucleic/agentic/runtime/graph/StateGraphEngine.ts#L351)
  - [runtime/graph/StateGraphEngine.ts#L366](/Users/david/Coding/nucleic/agentic/runtime/graph/StateGraphEngine.ts#L366)
  - [runtime/graph/StateGraphEngine.ts#L403](/Users/david/Coding/nucleic/agentic/runtime/graph/StateGraphEngine.ts#L403)
- Notes:
  - The parallel path passes `branchState` as both the mutable state and the retry snapshot.
  - Once the first attempt mutates `branchState`, the supposed snapshot is already contaminated.

### R4: Ollama structured path can emit invalid roles for tool-result history

- Status: Fixed
- Severity: Medium
- Impact: Structured calls with prior tool traffic can produce invalid or misinterpreted OpenAI-compatible payloads.
- Evidence:
  - [providers/ollama.ts#L69](/Users/david/Coding/nucleic/agentic/providers/ollama.ts#L69)
  - [providers/ollama.ts#L81](/Users/david/Coding/nucleic/agentic/providers/ollama.ts#L81)
  - [providers/openai-compatible.ts#L127](/Users/david/Coding/nucleic/agentic/providers/openai-compatible.ts#L127)
- Notes:
  - `OllamaProvider.structured()` maps `Message.role` directly instead of reusing the parent provider’s conversion logic.
  - Library role `tool_result` should be transformed to wire role `tool` with the required tool-call metadata.

## Verification

- `npm test`
- `npm run build`

## Delivery Status

### Wave 1

- Status: Complete
- Scope shipped:
  - `IPackRegistry` / `PackRegistry` rename
  - grouped `AgentContextAssembler`
  - `ToolRuntimeAdapter`
  - policy-aware `CompositeToolRuntime`
  - `ITickStep.after` ordering
  - `AgentRunner`
  - runtime bug fixes tracked as `R1`–`R4`

### Wave 2

- Status: Complete
- Scope shipped:
  - `ICapability<TState>` / `ICapabilityLifecycle<TState>`
  - `IPackManifest.capabilities`
  - `PlanningCapability`
  - `BudgetHintCapability`
  - `EmptyResponseCapability`
- Verification:
  - `npm test`
  - `npm run build`

## Design Notes

### agentic-v2-design.md

- Status: Reviewed
- Outcome: The current `agentic-v2-design.md` is internally consistent for Wave 1 planning after the recent fixes.
- Notes:
  - Barrel export responsibilities now match the current package structure.
  - `AgentRunner` is correctly decoupled from existing pattern state shapes for Wave 1.
  - `CompositeToolRuntime` Wave 1 scope no longer depends on unspecified tracing hooks.
  - `TickPipeline` now allows forward references and defers cycle detection to resolution/run time, which matches the intended cross-module ordering model.

### Follow-up Items

| ID | Status | Severity | Area | Summary |
|---|---|---|---|---|
| AR1 | Open | Medium | Agent surface | `AgentRunner` should use a real adapter contract for heterogeneous graph state instead of relying on a narrow key-based bridge and synthetic history reconstruction. |

#### AR1: AgentRunner adapter contract

- Status: Open
- Severity: Medium
- Impact: If `AgentRunner` remains a public surface, it should be reusable across different graph pipelines and preserve real session state/history across turns.
- Notes:
  - The long-term value of `AgentRunner` is as a reusable `IAgent` bridge over different graph state shapes, not as a wrapper around one assumed message/output layout.
  - A stronger design may need mapping functions or a richer adapter contract rather than only `inputKey`, `messagesKey`, and `outputKey`.
  - This remains useful even if a future Wave 3 capability composition layer becomes the primary agent-construction surface.
