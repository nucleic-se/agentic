# Alpha API migration: architecture audit fixes

These changes follow the September architecture audit. The library remains alpha; the changes below intentionally expose assumptions previously hidden by casts, ignored options or inconsistent selection rules.

## Budget-aware prompts and atomic groups

```ts
const builder = ai.use('balanced')
  .system(instructions)
  .contextGroup('project', [overview, conventions, examples], { priority: 80 })
  .context(recentNotes, { id: 'notes', priority: 30 })
  .user(question)
  .budget({ total: 16_000, output: 2_000 });

const { request, report } = await builder.prepare();
const answer = await builder.run({ signal }); // string
```

System text and user input are protected. Groups are single atomic items: all members remain or all are dropped. Groups have no recursively selected children. Priorities select content; phase controls placement. Recency breaks ties without increasing priority as a session grows. The legacy optional weight/multiplier fields are accepted for migration, but new callers should calculate one priority externally.

Preparation includes rendered text, message overhead, tools, structured schema and output reserve in its estimate. The reserve sets the actual output limit. Both context composers use the same section priority/protection and rendered-cost rules. Protected overflow fails explicitly. Default counting remains heuristic; supply a suitable token counter when needed.

`prepare()` performs no model call. It and `run()` use the same preparation path, capturing configuration before asynchronous work. A later call to `run()` prepares from the builder's then-current configuration; execute a captured `request` directly through the execution primitives if dispatch must use that particular snapshot. The report is available through the context assembler and is journaled with harness model intents without being sent to providers.

## Truthful structured output and pipelines

Plain builders return `string`. `schema(jsonSchema)` returns a separate builder producing `unknown`. Pass a parser to infer and validate the result:

```ts
const typed = ai.use().user(question).schema(jsonSchema, value => schema.parse(value));
const result = await typed.run();
```

Capture the returned structured builder. Direct construction uses `AIPromptBuilder.create(provider)` rather than a caller-chosen generic constructor. The unsafe `run<MyType>()` form is removed.

Pipelines are immutable: retain the returned chain. Input belongs to `ai.pipeline(input)`; `run(options?)` accepts only execution options. Type-changing steps do not mutate an earlier typed reference.

```ts
const flow = ai.pipeline(question)
  .llm(builder => builder.system(instructions))
  .retry(1)
  .transform(text => parseLocally(text));
const result = await flow.run({ signal, deadline });
```

Transform, validation and logging are separate steps. A parser failure above does not repeat the model operation. Put an intentional regeneration/replay sequence inside an explicit retried step, and own its effect safety. Return the configured structured builder from `llm` to infer its output. `catch` is terminal, preserving its output type. Deadlines reach custom steps and retry waits; custom asynchronous work must cooperate with its signal.

## Effects, lifecycle and recovery

Dispatched unknown, timed-out or cancelled tools stop subsequent effects centrally. An unexpected throw after dispatch is uncertain. `ToolExecution.status` includes `unknown`; consumers must handle it. Raw tool results survive post-execution hook failure; transformed results and hook failures do not rewrite whether the effect happened.

If extension activation fails after starting work, the harness cancels and drains it before closing storage. Normal and failed activation use the same cleanup path.

Resolve an unknown operation only after obtaining evidence from the external system:

```ts
await client.resolveOperation(sessionId, operationId, {
  expectedRevision: session.revision,
  evidence: 'Checked the destination; the expected write exists.',
  result: { ok: true, content: 'Write independently verified.' },
});
await client.resume(sessionId);
```

Resolution is journaled and revision-checked. It preserves the original operation evidence and updates the tool-result projection; it does not re-execute the effect or automatically resume. Stale, duplicate and still-uncertain resolutions are rejected. Very old interrupted intents lacking a tool call identity cannot be resolved through this API.

## Capabilities, limits and reads

Embedding consumers should require `IEmbeddingProvider`. Generation-only providers no longer implement throwing embedding stubs; the generation interface retains an optional embedding member for compatibility. Ignored graph model/temperature hints are removed, including ineffective pattern settings. Configure the actual provider instead. Structured requests now support `maxTokens`; providers reject truncated structured output even when its JSON parses.

`createHarness().compose({ extensions, limits })` accepts `maxModelCalls`, `maxToolCalls`, `maxToolCallsPerBatch` and `timeoutMs`; the reference preset also accepts limits. Defaults retain the prior limits. These run ceilings are distinct from a request's context capacity. `executionSignal` normalizes deadlines for model operations and pipelines.

Use `client.list({limit, offset})` and `client.events(id, afterSequence, limit)` for bounded reads. Memory and SQLite implement matching pagination contracts; the web API accepts corresponding query parameters. Omitting pagination preserves the existing all-results behavior. Offset pagination is for browsing, not a consistent snapshot during concurrent changes. Event sequence cursors are suitable for incremental reads.

Snapshot records still grow with history. This pass does not introduce an artifact store, automatic retention or distributed ownership. Gears should continue to own queues, scheduling and leases; the new contracts can be used by its future harness.


### Recoverable context now retains full evidence while it fits

`referenceToolResult` is now invoked only under context-budget pressure, in the
existing priority order. It no longer eagerly shortens every eligible older
result. No new option is required. Callers must keep retrieval callbacks pure;
callback invocation is a selection decision, not an indexing or persistence hook.
Existing protection, pairing, grant, source immutability and report contracts
remain intact. Gears advances its persisted context extension to version 3 so
active work cannot silently adopt the changed policy on restart.


### Audit boundary fixes

The default `tools.coding` extension is now version 2.0.0: searches run in a
terminable worker with a 30-second deadline, and file reads require regular files
and bounded output. UTF-8 line ranges return continuation offsets when capped;
`totalLines` is present only when EOF was reached. Oversized individual lines
return an error. Existing persisted compositions require their matching version;
no data migration or automatic replay is performed.

Graph model preparation now snapshots tool manifests before accounting and uses
that same snapshot for dispatch. Context protection predicates add to explicit
sticky protection. Gears advances its runtime extension to version 6 to preserve
the corrected handling of dispatched uncertain tool outcomes and follow-up
composition validation.

### Session cache routing

The default subscription provider extension is version `2.0.0`. The local host now journals a stable composition/session `cacheScope` on model requests, with request-level overrides supported. Reopen persisted sessions with their original composition; the changed default provider identity does not silently resume an older default composition. Custom providers may ignore the optional hint.
