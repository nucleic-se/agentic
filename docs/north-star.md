# North star

Build a small, composable agent foundation that can support reliable work on long,
complex tasks. Keep its code simple, beautiful, easy to understand and maintain.
Correctness, useful model context and understandable behavior come before feature
breadth. This is our design direction, not a claim that every capability exists today.

## One harness, multiple compositions

Agentic owns reusable agent primitives, composition contracts and shared execution
semantics. It ships an empty harness and a useful, maintained default agent.
Consumers should be able to assemble the primitives like building blocks without
reimplementing the machinery that makes them safe to combine.

The Gears agent is a composition of this harness with Gears infrastructure and
task-specific behavior. Develop both compositions together. Put generally useful
agent behavior in Agentic; put queue, scheduling, worker and infrastructure
integration in Gears. Reuse Gears infrastructure where it already solves the
problem. Extract shared behavior when there is a concrete need, without forcing
different hosts to expose identical clients or storage models.

Loop policy, context policy, providers, tools, session storage and UI belong behind
explicit extension boundaries. The host enforces the contracts between them.
Extensions are a means of composition, not a reason to turn every helper into a
plugin. UIs attach to the agent lifecycle; closing a UI should not implicitly
cancel its work. The default composition must remain useful without custom setup.

## Give the model the right information at the right time

The mental model is selecting useful context from more information than the model
can consume at once. A 128k-token window and 4 MB of task data illustrate that
problem; they are not fixed limits, targets or acceptance requirements. Evaluate
different workloads and model windows. Increasing the window or truncating old
messages alone does not solve the selection problem.

Keep durable source history and artifacts separate from the request assembled for
the model. Context construction should make room for the objective, current
progress, relevant evidence, tool definitions and reserved output. Preserve the
relationships between tool calls and results. Support priorities within composed
blocks without making callers manage a complicated allocation system.

Selection, retrieval, summarization and memory should fit this same architecture.
Retain source references so compressed information can be recovered. Make budget
decisions inspectable: what was included, shortened or omitted, and why. Treat
token estimates honestly and test whether selected evidence helps complete the
task, not only whether a request fits a ceiling.

## Make long work trustworthy

Subagents, durable progress and scheduled continuation should compose under clear
ownership, capability and resource limits. A child must not acquire capabilities
its parent lacks. Shared budgets must account for concurrent work. Cancellation,
shutdown and restart must have explicit, tested behavior.

Record effects and their outcomes so interrupted work can distinguish completed,
failed and unknown operations. Retry only when the effect's contract permits it.
Session storage and recovery must preserve these semantics across compositions.
Use the same shared contracts for model admission, context preparation and tool
execution wherever they apply.

## Simplicity is an acceptance criterion

- Prefer explicit control flow, small interfaces and clear ownership. A reader
  should be able to trace a request, its state changes and its failure path.
- Add an abstraction when it removes real duplication or enforces a useful
  contract. Avoid speculative layers, clever generics and thin wrappers that
  merely rename an operation.
- Keep dependencies minimal and isolate infrastructure from reusable behavior.
- Remove obsolete paths when replacing them. Alpha permits breaking changes;
  document persistence consequences and never silently discard user data.
- Test meaningful contracts and failure cases. Passing tests does not excuse
  an architecture that is harder to understand.

## Establish the foundation before expanding features

The next work should strengthen shared contracts and lifecycle ownership, context
construction and accounting, recovery, and conformance between compositions.
Resolve accumulated debt as part of that work. Add features once they have a clear
place in this foundation and can be exercised in real tasks.

Use Pi and Hermes as external benchmarks across the whole harness: context,
execution, tools, permissions, sessions, recovery, delegation, scheduling, memory,
providers, extensions and UI. Compare mechanisms and failure behavior as well as
feature presence. Validate comparisons against source code and distinguish
implemented behavior from proposals and measured results from expectations.
Keep the detailed competitor research outside the repositories.

Our intended strength is coherent composition with less code and less integration
work. Demonstrate that strength through shared conformance tests, realistic task
evaluations and dogfooding. Record failures as well as successes; a smaller passing
scenario does not establish reliability on a longer workload.

For each substantial change, ask: does it improve task outcomes or enforce an
important contract, does it belong at this layer, and is the resulting code easier
to understand? If the complexity costs more than the benefit, simplify the design.

See [the harness design](harness-design.md) for current implementation details and
limitations. This north star guides both the default Agentic agent and the Gears
composition; it does not expand their current feature claims.
