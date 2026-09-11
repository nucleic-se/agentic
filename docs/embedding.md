# Embedding Agentic

Start with the execution or session API that matches the lifetime your application owns.

| Application | Starting point | Application responsibility |
|---|---|---|
| Chat with application-owned history | `createHarnessExecution` from `/harness/core` | Store history and append returned responses |
| Coding agent with sessions and tools | `createDefaultAgent` from `/coding` | Supply a workspace/provider, submit work, observe completion and close the agent |
| Custom session agent | `createHarness().compose` from `/harness/core` | Select the six roles explicitly |
| Durable Gears worker | Gears `StandaloneHarness.open` | Admit and observe tasks; retain the host until work drains |

The kernel and `/execution` primitives support applications implementing their own orchestration. They share model and tool execution with the harness. You do not need to combine a kernel with a session host to use the coding preset. Existing `/harness` imports remain supported; the narrower imports make dependencies explicit.

## Chat with your provider

```ts
import type { ILLMProvider, Message } from '@nucleic-se/agentic/llm';
import { createHarnessExecution } from '@nucleic-se/agentic/harness/core';
import { budgetedContext } from '@nucleic-se/agentic/harness/context';

const execution = createHarnessExecution({
  provider, // An application-created ILLMProvider.
  context: budgetedContext('Answer the user clearly.', 8000),
});
const history: Message[] = [{ role: 'user', content: 'What is two plus two?' }];
const response = await execution.model({ messages: history, maxTokens: 1000 });
history.push(response.message);
```

This performs one model turn. It does not run tools or create a session store. The application owns the provider and history. Context selection receives a copy; it cannot replace your original history. Choose a context ceiling within your provider's capacity, including room for output.

The [chat example](../demo/embedding/chat.ts) is exercised with a deterministic provider, including cancellation and provider-local request mutation.

## Coding with your provider

```ts
import { createDefaultAgent } from '@nucleic-se/agentic/coding';

const agent = await createDefaultAgent({
  workspace: '/project',
  provider,
  tokenBudget: 16000,
  readOnly: true,
});
try {
  const session = await agent.create('Project review');
  await agent.submit(session.id, 'Explain the entry point.', { commandId: 'review' });
  const result = await agent.wait(session.id);
  if (result.status !== 'idle') throw new Error(result.error ?? result.status);
  console.log(result.messages);
} finally {
  await agent.close();
}
```

The provider must expose a stable, non-secret `configurationIdentity`, or the application must supply `providerIdentity`. Include the model, adapter behavior and relevant configuration in that identity; changing it changes the composition fingerprint. If the provider does not advertise context capacity, supply `tokenBudget` explicitly. Advertised capacity still caps the requested budget.

`model`, `reasoningEffort` and `authFilePath` configure the default subscription provider and cannot accompany a supplied provider. Omitting `provider` retains the existing subscription preset. A supplied provider bypasses subscription initialization and remains application-owned; closing the agent closes its tools and store, not the provider.

The [coding example](../demo/embedding/coding.ts) is tested through a real workspace read and a final answer, retaining the tool receipt and usage. The example uses an in-memory session store; supply `database` for local persistence. `readOnly` excludes editing and shell tools rather than relying on a policy to reject them.

## Durable workers

The Gears checkout contains `examples/agentic-harness/src/standalone/durable-agent-example.ts`. It embeds a request-review worker with an application-owned data source and one read tool, without coding tools or a UI. The example requires a nonempty provider `configurationIdentity` and request-source `identity`, so both participate in the durable composition:

```ts
const worker = await openRequestReviewWorker({ dataDir, provider, requests });
try {
  await serveRequests(worker); // Application admission and observation loop.
} finally {
  await worker.close();
}
```

Gears `create` and `send` acknowledge admission. Observe task completion through `inspect` or `store.get`; keep the worker open while tasks run. Its example tests close and reopen the database, preserve completed evidence, continue without replaying a completed lookup, and retain an uncertain model outcome for explicit reconciliation.

## Capabilities and ownership

Use distinct terms when composing capabilities:

- **Instruction packs:** `/skills` snapshots SKILL.md text. `read_skill` retrieves instructions through the tool boundary; loading a pack does not execute scripts.
- **Tool runtimes:** expose definitions, validation and execution. The legacy `/tools` `SkillToolRuntime` loads executable JavaScript modules and exposes `skill_run`; it is a different capability.
- **Lifecycle extensions:** provide roles or attach services through activation and cleanup. Role-owning extensions include stable configuration identity; an activation-only UI does not change the execution fingerprint.

| Resource boundary | Owner |
|---|---|
| Supplied preset provider | Application; the preset never closes it |
| Preset `additionalTools` factory result | Preset, including rollback after acquisition |
| Browser object passed directly | Application; the runtime owns only its contexts |
| Browser returned by a factory | Browser runtime, acquired lazily |
| Gears `toolRuntime` | Gears host immediately on `open`, including failed startup |
| Terminal attachment | Caller detaches it; detachment does not close the agent |

These existing boundaries are explicit without a generic resource wrapper. Custom drivers specify their own disposal policy. See [optional capabilities](./optional-addons.md) for composition and shutdown details.

## History and prepared context

History and model input serve different purposes. Keep original evidence in application history or the session journal; select a bounded projection for each model request. A prepared request belongs to the execution instance that created it. Its inspection properties return copies, and dispatch uses the private snapshot without rerunning selection.

```ts
import type { HarnessPreparationOptions } from '@nucleic-se/agentic/harness/core';
import { inspectOperation } from '@nucleic-se/agentic/harness/core';

const options: HarnessPreparationOptions = { preserveMessages: true };
const prepared = await execution.prepareModel({ messages: history }, options);
console.log(prepared.request); // An inspection copy.
const response = await execution.dispatchModel(prepared);

// For a journaled model operation, read the exact recorded request:
const evidence = await inspectOperation(agent, sessionId, operationId);
```

`preserveMessages` rejects a context strategy that removes or rewrites source messages; use it when lossless preparation is required. It does not disable budgeting. Session `replaceMessages` and maintenance are explicit journaled transcript changes. Inspection reads committed evidence without invoking a model or rebuilding context. Uncertain tool outcomes still require reconciliation; API simplification does not make replay safe.
