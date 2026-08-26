# Agentic v2 direction

Agentic is an alpha, self-contained framework for general and experimental
agent runtimes. Breaking changes are preferred over compatibility layers when
they restore a clear invariant.

## Framework boundary

Agentic does not depend on or get re-exported by Gears. The frameworks have
different purposes and release independently. Applications may use either or
both without making one framework part of the other's public surface.

Interoperability uses platform standards such as `AbortSignal`, JSON Schema,
async iteration, and trace identifiers. A shared implementation package should
only emerge if independent use supplies evidence that a shared primitive is
actually warranted.

## Core runtime direction

The core runtime is intentionally small:

```text
agent definition
      |
      v
turn kernel
  |-- provider port
  |-- context port
  |-- policy port
  `-- validated tool runtime
```

The kernel is the single authority for limits, policy, confirmation, and turn
consistency. Tool adapters validate and dispatch calls but do not authorize
them. Provider adapters translate protocols but do not own the agent loop.

Graphs, patterns, capabilities, memory experiments, and host tools remain
optional layers. They do not define the safety guarantees of the base kernel.

## Tool invariants

- Agentic owns a small, library-neutral `RuntimeSchema<T>` contract.
- The same schema exposes model-facing JSON Schema and runtime validation.
- Input is validated before a tool runs.
- Declared output is validated before it becomes a successful result.
- Duplicate tool names fail during composition.
- `confirm` is never executable authority.
- Policy is evaluated once, in the kernel.
- Cancellation and progress context reach the tool implementation.
- Timeouts stop the runtime from waiting and signal cooperative tools.

## Next kernel work

1. [x] Export a generic kernel from the runtime package.
2. [x] Add provider-level cancellation and deadlines.
3. [x] Validate a complete proposed tool-call batch before executing its first call.
4. [x] Disable heuristic text-to-tool recovery by default.
5. [x] Make context budgets strict success-or-error invariants.
6. [x] Keep side-effecting graph retries explicit and abort-aware.
