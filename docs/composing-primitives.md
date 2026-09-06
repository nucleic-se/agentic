# Composing Agentic primitives

Agentic supports two levels of composition: ordinary functions and interfaces for building a runtime, and an optional harness that supplies session lifecycle and extension wiring. Applications can use the first level without adopting the second.

| Responsibility | Shared primitive | Caller owns |
|---|---|---|
| Model operation | `executeModelTurn`, `executeStructuredModel` | Provider choice, retry policy, receipt storage |
| Tool batch | `executeToolBatchDetailed` | Tool manifest, authority, confirmation and durable event sink |
| Context | `collectPromptSections`, `composeAgentContext` | Contributors, scores, protected content, compression and token counter |
| Atomic state transition | `ExecutionJournal`, `commitJournalTransition` | Storage backend, serialization and conflict policy |
| Conversation lifecycle | Optional `createHarness().compose(...)` | Explicit extensions for store, loop, context, provider, tools and policy |

## A model operation without a harness

```ts
import { composeAgentContext } from '@nucleic-se/agentic/context';
import { executeModelTurn } from '@nucleic-se/agentic/execution';
import type { ILLMProvider, Message } from '@nucleic-se/agentic/llm';

export async function answer(provider: ILLMProvider, messages: Message[], signal: AbortSignal) {
  const context = await composeAgentContext({
    system: 'Help the user complete their task.',
    messages,
    tools: [],
    tokenBudget: 16000,
    reservedOutputTokens: 2000,
    signal,
  });
  const response = await executeModelTurn(provider, {
    system: context.system,
    messages: context.messages,
    tools: [],
    maxTokens: 2000,
  }, { signal, requireComplete: true, allowToolCalls: false });
  return { response, contextDecisions: context.decisions };
}
```

The same executor is used by the agent kernel, graph model nodes, fluent prompt builder and harness model effects. It snapshots requests, validates response structure and token usage, preserves ordered streaming, and distinguishes complete, partial, failed and aborted operations. Structured calls can provide an executable value validator in addition to the provider's schema.

`onIntent` is an awaited barrier before dispatch. `onOutcome` is an awaited receipt barrier before return. A receipt commit failure is propagated without fabricating a second provider failure receipt. `dispatched` distinguishes cancellation before transport from an interrupted request that may have reached the provider. The executor never automatically retries external effects. The caller decides what failures are safe to retry.

## Context as independent policy

Prompt contributors produce the existing `PromptSection` contract. Context composition renders these sections, estimates the complete request, selects content, optionally compresses it, and reports the result. Tool schemas, tool call arguments, tool identities, rich tool results, system text and the output reserve participate in the estimate. Supply a provider-specific token counter and image estimate when available; the default is an approximation, not a provider tokenizer.

Scores, sticky content, constraint sections and protected recent message groups control selection. An assistant's tool calls and their results remain atomic. Compressors may change text but cannot rewrite provenance, tool identity, arguments or media. If protected content cannot fit, composition fails explicitly. Callers can inspect kept, compressed and dropped decisions before dispatch.

`AgentContextAssembler` is a compatibility adapter over this function. `PromptEngine` remains the smaller synchronous section composer. They share section ordering; a consumer that needs complete model-request accounting should use `composeAgentContext`.

## Session storage and maintenance

`ExecutionJournal<State, Event>` requires only `get` and an atomic compare-and-swap `commit`. `commitJournalTransition` clones the current state, applies one update, increments its revision and commits an event with the same sequence. It makes one attempt. A Gears adapter can implement this boundary with its existing transaction infrastructure while keeping job queues, scheduling and leases in Gears.

The bundled harness extends this boundary with session discovery and event reads. Model receipts, known usage and transcript changes commit together. Tool intents commit before execution. An interrupted dispatched effect can remain unknown and blocks automatic repetition.

`SessionClient.maintain` runs a tool-free model operation with a caller-provided system instruction and pure transcript projector. It reserves the session, supports cancellation, budgets the final request and records the original messages in the replacement event. Partial or cancelled results never replace history. If projection fails, the successful model receipt and usage remain recorded while the old transcript is preserved.

UIs attach to `SessionClient`; detaching a browser or terminal does not own or cancel execution. Extension configuration belongs to the harness layer. Individual context and execution functions do not require extension registration.

## Alpha migration notes

- `AIPromptService.use(tier)` now selects an `IModelRouter` tier. Passing a tier without a router throws instead of silently ignoring it. Choose a concrete model when configuring the provider.
- Fluent `run` accepts provider cancellation/deadline options. Pipeline cancellation bypasses retry and recovery handlers. Retry counts must be nonnegative safe integers.
- Text builders and structured consumers reject truncated output instead of passing it downstream as a completed value.
- Context budgets include more of the actual request. Existing budgets that only fit by omitting tools, role overhead or image cost may now reject explicitly.
- `./context` and `./execution` expose the primitives without importing the optional harness, provider adapters or UI packages.

This boundary does not implement a distributed workflow engine or promise exactly-once external effects. Durable workflow orchestration belongs to the application infrastructure; Agentic supplies the operations and receipts it can compose.
