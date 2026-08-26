# Agent kernel

`runAgentKernel` is Agentic's generic bounded turn loop. It is a public alpha
API, not a claim of production maturity.

```ts
import { runAgentKernel } from '@nucleic-se/agentic/kernel';
import { ToolRuntimeAdapter } from '@nucleic-se/agentic/tools';

const conversation = [{ role: 'user', content: 'Do the task.' }];
const tools = new ToolRuntimeAdapter([myTool]);

const records = await runAgentKernel(
  conversation,
  {
    provider,
    tools,
    policy,
    maxTurns: 12,
    confirmToolCall: requestConfirmation,
  },
  () => ({ system: systemPrompt, messages: conversation }),
  event => eventLog.push(event),
  abortController.signal,
);
```

## Turn sequence

```text
assemble context
→ call provider
→ validate the complete raw call batch
→ evaluate policy and confirmation for the complete batch
→ apply hooks and revalidate rewrites
→ execute authorized calls sequentially
→ append assistant message and every tool result atomically
```

If any executable call is invalid, none of the executable calls run. The model
receives a validation result for the invalid call and synthetic skipped results
for otherwise valid calls, then may correct the batch on the next turn.

Policy is fail closed:

- a thrown policy evaluation becomes a denial;
- `confirm` without `confirmToolCall` becomes a denial;
- policy and hook rewrites are revalidated;
- duplicate call identifiers are protocol failures.

The kernel requires `IValidatedToolRuntime`. `ToolRuntimeAdapter` implements
this contract. `CompositeToolRuntime` rejects preflight for child runtimes that
do not provide executable validation.

Provider calls and tool calls receive the run's `AbortSignal`. Provider retry
delays and rate-limit waits are abortable. Tool cancellation remains
cooperative: Agentic cannot undo external side effects after they occur.
