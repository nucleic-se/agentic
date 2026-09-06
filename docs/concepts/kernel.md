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
    maxToolCallsPerTurn: 16,
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
→ apply beforeToolCall hooks and validate transformed inputs
→ evaluate policy and validate any policy rewrites
→ confirm the final arguments
→ reject validation that changes authorized arguments
→ execute authorized calls sequentially
→ append assistant message and every tool result atomically
```

If any executable call is invalid, none of the executable calls run. The model
receives a validation result for the invalid call and synthetic skipped results
for otherwise valid calls, then may correct the batch on the next turn.
The kernel also rejects an oversized proposed batch before validation or policy;
the default ceiling is 16 calls and callers may lower it explicitly.

Policy is fail closed:

- a thrown policy evaluation becomes a denial;
- `confirm` without `confirmToolCall` becomes a denial;
- policy and hook rewrites are validated before confirmation;
- subsequent validation cannot change authorized arguments;
- duplicate call identifiers are protocol failures.

The kernel requires `IValidatedToolRuntime`. `ToolRuntimeAdapter` implements
this contract. `CompositeToolRuntime` rejects preflight for child runtimes that
do not provide executable validation.

Provider calls and tool calls receive the run's `AbortSignal`. Provider retry
delays and rate-limit waits are abortable. Tool cancellation remains
cooperative: Agentic cannot undo external side effects after they occur.

Request records snapshot messages and tool definitions before the model call;
subsequent conversation reconciliation does not mutate earlier requests.
`beforeToolCall` runs before policy, so policies inspect the transformed intent.
Validators should produce stable canonical arguments: revalidating an authorized
input must not change its meaning or representation. The kernel passes
`ToolCallOptions.authorizedArgs`; custom runtimes must preserve those arguments
when validating again at dispatch. `ToolRuntimeAdapter` enforces this check.
