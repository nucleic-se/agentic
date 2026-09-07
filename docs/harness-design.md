# Composable harness: architecture and product plan

Status: foundation consolidation on feature branch, 6 September 2026.
Branch: `codex/composable-harness`.

The [north star](north-star.md) sets the enduring design priorities and review
criteria for this harness and its Gears composition.

## Foundation contracts

The harness composer no longer assumes local session execution. `createHarness().compose`
uses the local session driver by default. Passing `{ driver, extensions }` selects a
driver with its own typed roles and client, using the same dependency validation,
activation, failure cleanup and shutdown ordering. Gears supplies a queued driver
and a runtime role backed by its existing container, workers, mutex and database.
It does not wrap a second local loop around each queued task.

Both drivers use `createHarnessExecution` for model requests and tool execution.
The model boundary snapshots raw input, runs the selected `ContextStrategy` once,
validates its result and optional accounting, then invokes admission/journal hooks
before dispatch. Selection can change the request's system and messages; it cannot
change the tool manifest or mutate the original history through the supplied
snapshot. The operation deadline includes context preparation. Cancellation is
cooperative: custom context strategies must observe the supplied signal.

`budgetedContext(system, ceiling, policy)` directly composes the existing context
pipeline. Its optional policy supplies token counting, scoring, protection and
compression; the harness no longer routes this through the legacy assembler
adapter. The default reference agent sends an explicit output cap (4096 tokens by default),
which is reserved inside its context ceiling for both planning and conversation.
Custom loops must likewise specify an output cap when relying on complete-window
budgeting. Budgeted requests reject `previousResponseId`: opaque provider-held
history cannot be included in the local accounting. Unbudgeted integrations may
use provider continuation explicitly. Context reports contain estimates, not a
billing guarantee. Drivers that
reserve a shared token budget must require a report; full-history contexts remain
available for consumers that do not use token admission.

The bundled subscription OAuth transport removes the requested output cap before
HTTP dispatch. With that transport, the reserved output is a planning allowance;
reported usage can exceed it. The provider preserves actual usage for settlement.
Provider-neutral request snapshots describe the harness boundary, while transport
captures show provider-specific transformations; they are not identical wire formats.

Driver lifecycle contract:

1. All role names, ownership and extension dependencies validate before factories.
2. Role factories run in dependency order. Acquired roles have driver-declared
   disposers; a factory that fails before returning owns its partial cleanup.
3. `start` establishes the driver, then extensions activate. Failed activation
   closes the driver and releases all previously acquired resources.
4. `close` stops admission synchronously and drains accepted work. Extension
   disposers then run in reverse order, followed by role disposal. The public
   close promise is shared across callers.

A driver must drain its work before its close settles, even if shutdown reports
an error. A failed startup must stop any work it started before rejecting.
The composer owns resource cleanup; it cannot discover untracked background work.

`assertHarnessBoundaryConformance` from `@nucleic-se/agentic/testing` is run by both
the local session tests and the real queued Gears adapter tests. It verifies
request-only projection, unchanged tool capabilities, preserved source history,
and no provider dispatch after invalid or rejected context selection. Dedicated
execution tests cover deadline/admission failures and accounting consistency.
Each driver retains its storage, cancellation and crash-recovery tests.

Alpha compatibility: the default loop configuration and normalized composition
fingerprints can reject earlier persisted sessions. Use a fresh data directory
for this revision, or finish earlier work on its original revision. No existing
data is deleted or silently migrated.

This is a foundation consolidation, not automatic memory, retrieval or compaction.
Those must use this shared boundary when implemented. The local session client
and Gears task client intentionally expose different host operations; reusable
agent policies and effects should not be copied into a second implementation.

## Implemented in this branch

The branch now contains an empty typed host, a maintained-reference-agent starting
point, durable local sessions, a terminal client, and an authenticated browser
client. It is an initial implementation. Earlier audit fixes remain part of the working tree.

| Surface | Current implementation |
| --- | --- |
| Composition | Shared typed composer with a replaceable driver; the default local session driver requires six singleton roles: `store`, `loop`, `context`, `provider`, `tools`, `policy`; extension ID dependencies; API version 1; missing-role/conflict/cycle checks before factory calls; reverse cleanup on activation failure |
| Execution | `createHarnessExecution` shares request preparation and effect services across local and queued drivers; existing model/tool executors preserve intent-before-dispatch and receipt semantics |
| Loops | Conversational loop and planning loop; planning performs a tool-free model operation before the ordinary tool-capable loop |
| Context | Full history and grouped budgeted context, preserving tool-call/result groups |
| Sessions | Typed `SessionClient` with create/list/read/submit/resume/fork/cancel/approve, command deduplication, steering/enqueue queues, durable events and ephemeral deltas |
| Storage | In-memory store and optional SQLite adapter with revision checks, WAL, full synchronous commits, and local exclusive ownership |
| Reference tools | Validated filesystem/search tools plus cancellable, output-bounded shell execution; read tools allowed, mutations and shell require approval |
| Interfaces | Detachable line-based terminal UI and local/LAN browser UI with token login; both use the same client |
| Default provider | Existing Codex subscription authentication, default `gpt-6-astra`; live request verified during development |

The actual `LoopServices` interface exposes `model.request`, `tools.executeBatch`,
`context()`, `messages()`, `append()`, `takeQueued()`, and `signal`. The host owns
projection: returned model messages, tool results, and delivered queued messages
are already committed. Loops must not append those again. Use
`model.request(request, { projection: 'none' })` for internal model operations
that should be journaled without entering the visible conversation. `append()`
is for explicit additional loop notes.

Model operation records are independent of turns, allowing several model calls
before tools. The host currently limits a run to 40 model calls, 100 proposed tool
calls, and 16 calls per tool batch; the reference loop also defaults to 20 turns.
Usage is recorded, but these counters are not a monetary budget implementation.

The SQLite adapter lazily loads `node:sqlite`, falling back to separately installed
`better-sqlite3` if the built-in module is unavailable. The library's Node minimum
remains 20.18.1. For the durable demo, Node 22.13+ avoids the SQLite flag needed by
earlier Node 22 versions. Built-in SQLite first appeared in Node 22.5.
[Node SQLite history](https://nodejs.org/api/sqlite.html)

On restart, unfinished operations become `unknown`, active approvals are
invalidated, and missing tool-result messages receive explicit interruption
results. Unknown tool outcomes block further execution and forks. The host does
not blindly replay them. There is currently no user-facing reconciliation API:
inspect the execution history and use a new session when an unknown tool outcome
cannot be resolved. Approvals survive browser/terminal detachment while the host
continues running; they are deliberately invalid after process recovery.

Forks copy the current safe snapshot and record parent ID/revision. They do not
yet implement a storage-efficient branch DAG or selection of historical fork
points. Forks do not inherit queued commands or approval authority. Execution
resume checks the composition fingerprint; history remains readable independently.

See [README usage](../README.md#composable-harness-and-reference-agent) for build,
terminal, phone-on-Wi-Fi, token-file, and custom composition instructions.

## Current limits and remaining work

- The session controller is currently implemented by the host. Storage is a
  replaceable role; a separately replaceable rich session-management service is
  still a target, not a shipped capability.
- The extension SDK has singleton roles and activation callbacks. General
  namespaced additive tool/command/context-source registries, adapters for older
  pack/capability APIs, plugin discovery, and hot reload remain future work.
- Extensions are trusted local code. Filesystem path checks and approval do not
  sandbox arbitrary shell commands or malicious extensions. Cross-platform
  process-tree termination and host isolation still need broader validation.
- SQLite supports one owning host process. Multiple UIs connect to that host;
  distributed leases, remote workers, and exactly-once external effects are not
  provided. Ambiguous lock ownership fails closed.
- Session records currently store full JSON snapshots alongside event records.
  Large-history retention, indexed search, pagination, artifact storage, extension
  state migrations, and long-term memory integrations need additional work.
- Context pruning uses token estimates; the preset does not yet offer rich
  compaction inspection or context editing. The reference system prompt asks the
  model to read `AGENTS.md`; deterministic instruction discovery is not built in.
- The terminal is a simple line UI, not a full-screen TUI. `/model`, interactive
  context inspection, richer rendering, and a dedicated NDJSON client remain
  planned. Headless embedding already works through `SessionClient`.
- The browser adapter targets trusted local/LAN HTTP, with no TLS or public
  hosting configuration. A phone needs the same reachable Wi-Fi, the printed
  host address and token from `DATA/web-token`; the host must remain awake.
- Automated regression coverage and a live provider smoke check do not establish
  competitive task success or production readiness. Comparative evaluations and
  a sustained real-work hardening cycle remain necessary.

The sections below preserve the specialist decisions and target architecture.
They are a roadmap; the implementation table and limits above identify what
actually exists in this branch.

## Product direction

Build two deliberately different surfaces:

1. An empty, embeddable extension host. No implicit loop, provider, context,
   storage, tools, or UI. Merely constructing the host opens no files or network
   connections. A runnable composition explicitly supplies its required roles.
2. A maintained default agent assembled entirely from extensions. It should be
   useful for daily work, with a terminal UI and a headless interface, rather
   than a disposable example that only demonstrates registration.

Working assumption: win first on developer/terminal workflows, then expand into
persistent assistant workflows. This is a sequencing recommendation, not a
restriction on the harness. Equal first-release emphasis on coding, messaging,
automation, long-term memory, and remote fleets would dilute the first product.

The design should let applications replace context, orchestration, storage, or UI
while preserving execution history, approval semantics, cancellation, and recovery.
Validate this through working integrations and evaluations.

## Specialist debate and decisions

Three independent agents reviewed runtime architecture, session durability, and
plugin/UI design. The primary agent researched the competing products. The
specialists exchanged challenges directly before these conclusions were formed.

| Question | Alternatives debated | Recommendation |
| --- | --- | --- |
| Can everything be replaceable? | Universal hooks versus explicit roles | Replace implementations; standardize the guarantees between them |
| How much does a loop own? | One-turn helper versus model/tool effect services | Lower-level services; a turn helper is optional convenience |
| Are sessions optional? | Hidden default session versus no runtime scope | Empty host installs nothing; a runnable preset explicitly selects ephemeral or durable sessions |
| What does storage mean? | Save transcript at turn end versus journal effects | Journal intent/outcome and derive conversation views |
| Durable v1 backend? | JSONL files versus SQLite | Optional SQLite adapter plus in-memory test adapter; JSONL for interchange if needed |
| Is UI a plugin? | UI owns loop/session versus client protocol | UI uses commands, queries, and events; it owns presentation |
| What ships first? | Toy demo versus broad agent platform | Maintain a useful default developer agent; defer platform breadth |
| How far does recovery go? | Distributed workflow engine versus local durability | Single-host execution first; honest unknown outcomes after crashes |

The meaningful disagreements changed the plan. A thin `runAgentTurn` wrapper is
not sufficient as the extension boundary, a JSON transcript file should not be
presented as a durable engine, and a demo alone is not a competitive product.
At the same time, durability must not become an excuse to build a distributed
workflow platform before delivering a usable agent.

## Fixed contracts, replaceable implementations

| Shared contract/invariant | Extension-owned behavior |
| --- | --- |
| Composition checks and lifecycle cleanup | Which extensions a preset selects |
| Session/run/operation identity and record format | Session routing, naming, retention, search, fork UX |
| Commit ordering and revision checks | In-memory, SQLite, or host-provided storage |
| Validation → policy → exact approval → execution | Policy rules, tools, execution environments |
| Cancellation and usage accounting | Loop decisions and model routing |
| Immutable reads and explicit state transitions | Context assembly, pruning, compaction, memory |
| Commands, queries, interactions, event envelopes | TUI, headless client, later web/editor/channel UIs |

These are behavioral contracts, not an instruction to put all functionality in
one core class. Session management itself remains an extension. Core libraries
hold ports and enforcement helpers; an application such as Ivy can continue to
own persistence. Agentic need not depend on Gears or another scheduler.

Extensions initially run as trusted local JavaScript/TypeScript. Restricted
interfaces prevent accidental coupling; they do not sandbox a malicious Node
module. Untrusted execution requires a separate process/container boundary.

## Composition model

Use one typed extension front door, with explicit contributions:

- Single-selected roles: loop strategy, context strategy, session service, model
  router, policy evaluator. Each role may internally compose multiple components.
- Named additive contributions: tools, commands, context sources, observers,
  provider adapters, and UI adapters.
- Explicit dependencies, compatible protocol versions, and namespaced IDs.
- Deterministic dependency order; duplicate owners, missing dependencies, cycles,
  and incompatible versions fail before activation.
- Explicit host/session/run lifetimes prevent accidental cross-session state leakage.
- Activation returns cleanup handles; failure disposes previously activated
  extensions in reverse order. No registration by import-time side effects.
- Composition is stable during an active run. Hot reload is a later concern.

The host should explain the resolved composition: which extension owns each
role, why it was selected, and which configuration is active. Do not use
last-registration-wins behavior for important services.

The existing `ICapability`, pack bootstrap, and kernel hook APIs need adapters,
not a fourth disconnected extension architecture. Existing consumers continue
to use them; new harness compositions use the typed front door.

## Loop and execution boundary

A loop receives immutable session reads and shared effect services, conceptually:

```ts
interface LoopServices {
  model: ModelEffects;
  tools: ToolEffects;
  context: ContextStrategy;
  session: SessionScope;
  interactions: InteractionService;
  signal: AbortSignal;
}
```

This is a design sketch, not a published interface. `ModelEffects` owns provider
invocation, request/response records, and usage accounting. `ToolEffects` owns
whole-batch preflight, final-argument policy/confirmation, dispatch, and effect
journaling. Session scope exposes constrained transitions, not a mutable message
array or arbitrary edits to authoritative history.

A custom loop can make several model calls before tools, branch its reasoning,
or implement a planner/executor. It must not need to reproduce approval,
persistence, or cancellation machinery. The canonical record cannot assume one
model request per turn: use operation IDs and parent operation IDs, then derive
legacy `TurnRecord` objects for the default kernel compatibility layer.

Keep `runAgentKernel` working as the familiar default orchestration wrapper.
Extract shared execution services from it instead of rewriting providers and
tools. Keep graph workflows as an available orchestration choice, not a required
representation of every agent.

## Sessions and storage

Separate session semantics from the storage driver. A session service selects
and routes sessions, provides snapshots, handles commands, and supports forks.
Storage provides atomic append/commit with an expected revision. Both ephemeral
and durable implementations obey the same protocol.

Minimum identities and records:

- Session ID, run ID, operation ID, event ID, schema version, and durable sequence.
- An operation intent, start/dispatch state, outcome, and reconciliation state.
- Command IDs for duplicate detection; pending interactions bound to exact actions.
- Namespaced, versioned extension state and a resolved composition description.
- Parent session and parent revision for forks.

Durable ordering belongs in the effect services:

1. Persist the planned effect before executing it.
2. Execute through the shared authorization boundary.
3. Persist the outcome before reporting it as committed.
4. Derive the conversation projection idempotently from committed records.

If an external side effect happens and the process dies before its result is
committed, the result is **unknown**. Do not silently repeat an effectful tool.
A durable local append does not provide exactly-once external execution. Recovery
can reconcile idempotent operations or require user action, depending on tool
metadata and the available evidence.

V1 should be local and single-owner for active session execution. Reject competing
writers explicitly, and use revisions to reject stale commits. Revision checks alone
do not prevent two owners from launching duplicate external actions. Defer distributed
leases, remote worker reclamation, and arbitrary workflow migration. A fork
references an immutable parent revision and writes its own suffix; it never
reexecutes ancestor tool calls merely to reconstruct history. Fork only from safe
committed boundaries initially, without inheriting pending approvals, queued
commands, or active executions.

Ship an in-memory adapter for tests and ephemeral runs. Prefer SQLite for the
first durable adapter, isolated behind an optional package boundary. The current
Node minimum is 20.18.1, so do not assume `node:sqlite` is available; select and
verify a compatible driver without forcing native storage dependencies on every
Agentic consumer. Do not change the supported Node minimum silently.

History must remain readable without loading its original plugins. Resuming
execution requires compatible extensions or explicit migration. A state migration
and its applied marker commit in the same transaction.

## UI and interaction protocol

A UI extension connects to a session client:

- Commands: submit, steer, enqueue follow-up, cancel, resolve interaction,
  create/resume/fork session.
- Queries: session snapshot, pending interactions, composition, budget/context
  state, session list.
- Events: durable sequence envelopes plus ephemeral streaming updates carrying
  session/run/operation/message identifiers.

Detaching a UI is not cancellation. Reattachment retrieves a snapshot and resumes
from a durable cursor, including outstanding approval requests. An approval must
reference the exact pending action; stale or cross-session replies fail closed.

Persisted records are not UI subscribers. Durable commits are awaited by the
execution boundary. UI/telemetry observers use bounded delivery and isolation:
a broken renderer must not become a provider transport failure or lose a tool
result. Slow clients can coalesce/drop ephemeral deltas and recover a snapshot;
committed state is recoverable from the journal.

The first UI should be a simple, usable terminal client with streaming text,
visible tool activity, input history, cancellation/steering, approvals, and session
resume/fork commands. Build a headless NDJSON client alongside it to prove the
runtime does not depend on terminal APIs. Full-screen widgets, themes, and other
channels can come later.

## Delivery stages and acceptance gates

### 1. Extract and preserve behavior

Define operation/session/interaction contracts; extract model and tool effect
services; preserve existing kernel behavior with compatibility tests. Retain the
current audit regression suite.

Gate: default orchestration passes existing tests; a custom orchestration makes
two model calls before one tool batch using the same authorization and accounting.

### 2. Empty host and explicit composition

Implement role resolution, dependency checks, activation/cleanup, and explicit
ephemeral sessions. Provide two loop strategies and two context strategies.

Gate: an empty host performs no work; missing roles produce useful diagnostics;
conflicts fail before activation; failed activation cleans up all resources.
Switching loop/context does not require changing tools or UI.

### 3. Local durability

Implement the journal/storage contract and optional SQLite adapter. Add revision
checks, crash-state recovery, pending interactions, and immutable fork lineage.

Gate: kill/restart before dispatch, after a side effect, after outcome commit,
and before projection. Committed history survives; uncertain effects are marked
unknown and never automatically repeated; stale writers and approvals reject.
The in-memory and durable adapters pass one storage contract suite.

### 4. Maintained default agent

Assemble providers/model configuration, coding tools, project instructions,
context compaction, policy, session service, TUI, and headless client as extensions.
Include `/new`, `/resume`, `/fork`, `/model`, and composition/context inspection.

Gate: the same task can run headless or in the TUI, resume after restart, handle
cancellation and approval, and preserve records when the UI disconnects. Run
real coding tasks with visible changes and tests; a mocked happy path is not enough.

### 5. Evaluation and expansion

Measure task completion and regression rate, cost/tokens per successful task,
time to first output, cancellation latency, recovery correctness, and the effort
to write an extension. Use repeatable tasks with documented model, tool permissions
and budgets. Record limitations alongside measurements.

Expand into MCP/skills interoperability, richer TUI, editor protocols, memory,
background jobs, and channel adapters in response to measured needs. The external
protocol adapters remain extensions; the core should not grow a messaging SDK.

## Scope and migration

This is still reusable Agentic code, but the requested competitive product is
larger than the earlier simple demo. It requires substantial kernel/session work
plus additive extension and UI packages. Package layout should separate the
small harness, default agent preset, UI, and optional durable adapter without
forcing an immediate rewrite of the repository into a large monorepo.

Before publishing the extension SDK, prove at least two implementations of the
important slots. Defer marketplaces, arbitrary hot reload, distributed scheduling,
and untrusted plugin sandboxing until the local product and contracts are stable.

## Runtime inspection

Use **Inspect session** in the browser, or call
`inspectHarness(client, sessionId, afterSequence)` from `@nucleic-se/agentic/harness`.
The authenticated HTTP equivalent is `GET /api/sessions/:id/inspect?after=0`.
A snapshot contains capture time, state revision, committed state and up to 200
trace events. `nextSequence` is the next page's `after` cursor. Events newer than
the captured state are excluded; refreshing captures a new revision. A downloaded
JSON file contains the displayed state and trace page, not every historical page.

For each model operation, `state.operations[].input` is the exact `TurnRequest`
admitted to the provider adapter, recorded before dispatch. It includes selected
system/messages, tools and output cap. `contextReport` records selection decisions
and token estimates when the strategy supplies them. Operations retain outcomes;
trace events expose transitions and model duration. The inspector also exposes
queued input, approvals, usage and interrupted effects. Inspection never calls
the context strategy, tools or model and does not interrupt execution.

This is a committed-state view, not a debugger of arbitrary extension internals.
Before admission there may be no selected request yet. Pending intent does not
prove a network dispatch occurred. Provider-specific wire transformations, hidden
provider history and private model reasoning are outside this boundary. Raw history
is distinct from the selected request. Snapshots contain task/tool content and
use the same authentication as the session; credentials used by transport are not
added to them. No automatic trace retention or redaction policy is introduced.

### Stable instructions and transient task state

Compositions should keep enduring instructions separate from changing counters,
progress and retrieval hints. Gears now appends one deterministic, sticky user
message with current state to each model request. It uses existing `Message`
provenance and protection and the same context accounting; no separate context
extension protocol is needed. Model-written progress is labelled as untrusted
content rather than inserted into the system instruction.

Transient state belongs to the request intent, not accumulated conversation
history. The next request projects fresh state. This keeps stable instructions
and available history reusable as a prefix, without promising provider cache hits.
The default Agentic agent already keeps its configured system instruction stable;
it does not need Gears task-tree fields or a parallel implementation of them.

### Recoverable tool evidence

`ContextCompositionOptions.referenceToolResult(message, messageIndex, tools)` is
an optional host policy. Return a retrieval instruction only when the original
text is durably available and the current task can retrieve it; otherwise return
`null`. The callback receives isolated snapshots. Hosts own reference validity
and must preserve the source behind it across later projections and restarts.

Only under budget pressure, the pipeline considers eligible older tool-result text
longer than 1,200 characters for a 400-character preview and that reference,
only when doing so reduces estimated tokens. It uses the existing ascending
priority order (oldest first for tied message groups) and stops as soon as the
request fits, including between results in the same tool-call group. Fitting
contexts stay intact and do not invoke the reference callback. Protected/recent groups, error
results and native content blocks are excluded. Tool-call identities and grouping
remain unchanged; original history is never mutated. Selection reports include
source indices, retrieval instructions and original/retained character counts.
A later pressure compressor cannot erase the reference. The existing whole-group
drop policy still applies if the request remains too large.

When this policy is configured, implicit lossy text truncation is disabled;
callers may still explicitly supply a compressor for unreferenced messages.
This is deterministic retention, not a semantic summary or automatic relevance
search. The default Agentic composition does not enable it without a retrieval
implementation. Gears supplies its own-task `read_tool_result` capability backed
by existing durable conversation storage; no second memory database is added.


### Closure during extension activation

Closing a client during activation stops the driver and drains registered cleanup.
If the in-flight activation subsequently returns a disposer, the composer runs
it immediately and rejects composition instead of returning a closed client.
Remaining extensions are not activated. An activation may await `close()` without
deadlocking; cleanup acquired after closure is still attempted exactly once.


## Working checkpoint primitives (experimental)

### A turn through the shared execution boundary

Both hosts prepare a request, read its context report, and dispatch that same
preparation. Preparation is local: it selects context and validates accounting,
without calling the provider or committing an execution intent. The local host
uses its session messages; Gears first derives a checkpoint view and may substitute
a maintenance preparation when historical evidence needs summarizing.

Dispatch awaits the host's intent callback before contacting the provider. The
local host journals the exact request and report. Gears additionally checks lease
ownership, task generation and shared budgets, then reserves usage in the same
transaction as its intent. Admission failure therefore prevents provider dispatch.
The receipt callback commits usage and the resulting conversation or checkpoint
projection together. Gears schedules tool execution as a separate queue step;
both hosts use Agentic's execution primitives and tool-result conversion.

Recovery reads durable intents and receipts, never a serialized preparation handle.
An interrupted operation with an uncertain external outcome requires reconciliation
before continuation; reopening storage is not permission to replay it. Request
snapshots explain what was sent, while receipts and host state explain what was
committed. These are separate facts when a process stops between dispatch and commit.

### Source views and maintenance

`checkpointView(history, checkpoint, transient)` derives the model-visible view
and its source map together. Original messages remain in the host's append-only
archive. Transient host state has no archive index. The latest human message stays
verbatim even when its source is covered by a checkpoint; model and deterministic
messages do not replace that protected instruction.

`WorkingCheckpoint` stores `through` (exclusive end of complete source groups) and
`text`. An oversized group adds `partial: { end, offset }`: progress into the
UTF-16 JSON representation of indexed messages `[through, end)`. Each maintenance
request records its exact source range and, for chunks, offset/endOffset/total
characters. A group stays intact in the active view until its last chunk commits;
no partial tool-call group is presented as completed history. Each new summary is
a self-contained replacement, including any previous partial summary.

Context decisions record whether a change was caused by `budget` pressure or an
optional `presentation` cap.
`prepareCheckpoint` starts when older, unprotected history is shortened under
that pressure or dropped. It does not wait for eviction after recoverable tool
previews have already made the request fit. Fitting contexts and shortening
confined to protected recent groups do not start maintenance.

`prepareCheckpoint` first fits whole source groups, retaining the protected recent
tail, then uses bounded chunks if
the first outstanding group cannot fit. Fitting makes no model calls. The host
commits the returned cursor and summary only after a complete response, atomically
with its receipt and usage. Failed or partial model responses leave the old cursor
and summary unchanged. Persist partial progress just like completed-prefix progress.
The archive must not be edited or reordered while these cursors refer to it.

`createHarnessExecution().prepareModel()` returns an execution-owned preparation.
Its request/report getters return inspection copies. `dispatchModel()` accepts only
preparations from that execution and sends the internal snapshot; editing an
inspection copy cannot alter its request or accounting. Preparations are not
serializable dispatch handles. Persist the inspected request/report as evidence,
then prepare again for a new admitted operation after recovery.

Checkpoint preparation requests `preserveMessages: true`. Custom context strategies
must retain the supplied source messages exactly or preparation fails before
admission. They still control accounting and the context ceiling. This separates
lossless maintenance input from ordinary selective context assembly.

`toToolResultMessage` is shared by local and durable hosts. It preserves native
content blocks and copies mutable content-block objects; hosts apply their presentation
policy explicitly before conversion and commit the resulting message with its
receipt. Source retrieval may remain text-only; rich ordinary tool results are
not silently flattened.

The Gears composition drives automatic checkpoints. The local session driver
continues to expose explicit maintenance; shared primitives do not require every
composition to use the same policy. A protected instruction, prior summary or
output reservation that alone exceeds the ceiling cannot be fixed by dropping
history. Context errors identify protected-content overflow. Chunking also costs
real model calls and can exhaust a task budget. Checkpoints remain lossy model
summaries, not proof of fidelity; source ranges, original records and receipts are
necessary for inspection. JSON chunking preserves serialized source text but does not claim
native vision understanding of image data encoded in checkpoint source JSON.
