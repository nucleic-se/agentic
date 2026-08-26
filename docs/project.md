# Project tracker

This tracker records implemented changes and open integration work. “Tested”
means the named automated checks passed in this repository; it does not imply
production maturity or real-world validation.

## Agentic v2 foundation

| ID | State | Evidence | Change |
|---|---|---|---|
| A1 | Implemented and tested | Kernel tests | `runAgentKernel` is the single base turn-loop authority. |
| A2 | Implemented and tested | Tool adapter and kernel tests | Executable tool schemas, complete-batch preflight, output validation, and collision rejection. |
| A3 | Implemented and tested | Kernel tests | Policy, confirmation, callback rewrites, and extension failures fail closed or normalize deterministically. |
| A4 | Implemented and tested | Provider tests | Provider cancellation/deadlines and default-off text-to-tool recovery. |
| A5 | Implemented and tested | Context assembler tests | Context budgets return a valid selection or `ContextBudgetExceededError`. |
| A6 | Implemented and tested | Graph tests | Per-run cancellation, isolated attempts, abortable retry backoff, and explicit retry-risk acknowledgement. |
| A7 | Removed | Clean package inspection | Obsolete `AgentRunner`, demo `CodingAgent`, and `./agent` export. |

## Gears boundary

| ID | State | Evidence | Change |
|---|---|---|---|
| G1 | Implemented and tested | Gears build/tests and package inspection | Gears has no Agentic dependency, re-export, LLM provider, prompt service, or agent runtime. |
| G2 | Implemented and tested | Gears CLI test | `gears top` uses plain `blessed`; the abandoned `blessed-contrib` dependency tree was removed. |
| G3 | Audited | `npm audit` | Current installed Gears dependency tree reports zero known advisories. |

## Ivy integration work

These items intentionally belong to Ivy rather than either framework:

| ID | State | Requirement |
|---|---|---|
| I1 | Implemented and tested in Ivy | Ivy has an `IValidatedToolRuntime`; definition loading rejects unsupported schema keywords and tests cover its TypeBox `anyOf`/`const` shapes. |
| I2 | Implemented and tested in Ivy | Manual JSON tool calling is an Ivy `ILLMProvider` adapter; native and manual paths share `runAgentKernel`. |
| I3 | Implemented and tested in Ivy | Ivy maps allow-list policy, fail-closed confirmation, hard context budgets, shared cancellation, events, and persisted `TurnRecord`s onto the kernel. |
| I4 | Implemented and tested in Ivy | Focused native/manual, cancellation, policy, reconstruction, journal, and host tests pass; the superseded strategy loop was removed. |

See [Ivy runtime boundary](./ivy-runtime-boundary.md) for the ownership and
migration contract.
