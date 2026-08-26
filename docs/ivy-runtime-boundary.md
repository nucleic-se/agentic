# Ivy runtime boundary

This document describes the intended integration boundary for a future Ivy
Agentic runtime. It reflects the currently inspected local Ivy code and the
alpha APIs in Agentic and Gears; it is not a maturity claim.

## Ownership

| Layer | Owns | Must not own |
|---|---|---|
| Ivy | Agent definitions, identity and authorization context, conversation persistence, context policy, tool implementations, user confirmation, runtime selection, event mapping | Provider protocol details, generic retry machinery, Gears internals |
| Agentic | Provider adapters, bounded agent loop, executable tool validation boundary, tool policy sequencing, cancellation propagation, turn records | Ivy domain rules, durable job scheduling, application persistence |
| Gears | Queue, scheduler, store, workers, process lifecycle | LLM contracts, prompts, agent loops, Agentic re-exports |

The dependency shape is intentionally application-level composition:

```text
             Ivy
            /   \
     Agentic     Gears
   agent runtime  durable work
```

Agentic and Gears do not depend on each other.

## Ivy target composition

For the new runtime, Ivy should compose `runAgentKernel` with:

1. An Agentic `ILLMProvider` selected by Ivy's provider factory.
2. An Ivy-owned `IValidatedToolRuntime` adapter over the selected folder agent.
3. An Ivy-owned `IToolPolicy` using authenticated sender, room, agent, and job context.
4. Ivy confirmation and lifecycle hooks.
5. An Ivy context assembler that returns a context within a hard budget.
6. An `AbortSignal` owned by the Ivy session, job, or daemon operation.
7. An event adapter from `AgentEvent` to Ivy's public and persisted event forms.

Ivy remains the owner of its durable conversation. The kernel receives the
caller-owned message array and commits reconciled assistant/tool-result batches
to it; Ivy decides when and how that conversation is persisted.

## Required tool adapter change

Ivy currently defines tools as provider-facing `ToolDefinition` JSON Schema plus
`callTool(name, args)`. That is not sufficient for the new kernel because JSON
Schema metadata does not execute itself.

The Ivy adapter must implement `IValidatedToolRuntime` and provide:

- provider-facing definitions from the agent folder;
- side-effect-free `validate(name, args)` using Ivy's executable validator;
- normalized, non-throwing `call(name, args, options)`;
- `AbortSignal` and `callId` propagation into tools that support them;
- an explicit trust tier for policy evaluation.

Ivy's current `validateToolCallBatch` is a reasonable starting point, but its
supported JSON Schema subset must be explicit. Unsupported schema keywords
must fail at agent-definition load time rather than being silently ignored.

Do not add a schema-library dependency to Agentic solely for Ivy. Agentic owns
the small `RuntimeSchema<T>` interface; Ivy chooses or implements the validator.

## Native and manual tool calling

The kernel consumes normalized `TurnResponse.toolCalls` regardless of provider.
Native providers already produce that form.

If Ivy retains its manual JSON tool protocol, implement it as an Ivy provider
adapter that translates a validated manual response into normal Agentic tool
calls. Do not add manual-protocol branching or heuristic text parsing to the
kernel. Agentic's optional heuristic recovery remains disabled by default.

## Failure and cancellation mapping

- A context-budget error stops before a provider request.
- Invalid tool arguments reject the complete executable batch before policy or execution.
- Policy and confirmation fail closed.
- Provider, retry-backoff, graph, and cooperative tool cancellation use the
  same Ivy-owned `AbortSignal`.
- Tool timeouts stop waiting and signal the implementation; they cannot undo
  an external side effect that already occurred.
- Ivy persists the returned `TurnRecord` and maps terminal `FailureKind` values
  to its daemon/job state without inferring success from process survival.

## Migration order

1. Update Ivy's pinned Agentic and Gears revisions independently. Refreshing
   Gears must remove its old transitive Agentic dependency from Ivy's lockfile.
2. Replace `createDefinitionToolRuntime` with a validated adapter.
3. Wrap manual tool calling behind an `ILLMProvider` adapter if it remains required.
4. Map Ivy configuration and events onto `runAgentKernel`.
5. Run the new and old Ivy runtimes only in explicit A/B tests; do not nest or
   cascade one loop inside the other.
6. Delete the old Ivy Agentic loop after behavioral tests cover the replacement.

## Readiness checklist

- [x] Agentic and Gears have no dependency or re-export relationship.
- [x] Gears has no LLM or agent-runtime surface.
- [x] Agentic has one base public-alpha kernel authority.
- [x] Complete tool batches are validated before execution.
- [x] Policy, confirmation, and rewrites fail closed.
- [x] Provider and graph cancellation are propagated.
- [x] Context budgets are success-or-error invariants.
- [x] Agentic provider conformance tests cover Anthropic, OpenAI-compatible, and Ollama cancellation/protocol behavior.
- [x] Ivy implements the executable validated-tool adapter.
- [x] Ivy maps kernel records/events and demonstrates restart-safe persistence.
- [x] Ivy runs end-to-end native and manual tool-calling tests.

These checks describe current automated evidence across the local alpha
repositories. They are not a production-maturity or real-world reliability claim.
