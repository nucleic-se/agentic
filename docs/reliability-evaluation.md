# Reliability and context evaluation

Run the deterministic checks without credentials:

```sh
npm run test:reliability
npm run eval:context
```

The crash suite starts real child processes, kills them at explicit IPC barriers,
and reopens the SQLite session store in a new process. It covers durable intent
before tool dispatch, a durable external effect before receipt persistence, and
a committed receipt before run completion. Recovery must not silently replay
uncertain effects; evidence-based resolution is required. These are selected
process-crash boundaries, not a power-loss or filesystem durability certification.

The context corpus measures required-constraint retention, answer-evidence
retention, estimated tokens before and after preparation, compression, and group
integrity. It covers long noisy histories, atomic source groups, explicit
compression, interleaved tool messages, and required-content overflow. It fails
on missing required facts, budget overruns, or failed oracle checks. The oracle
is deterministic: it does not measure live model task success.

For a separate, opt-in model check using existing Codex subscription auth:

```sh
# Defaults to gpt-5.6-terra for routine dogfooding
npm run eval:live
# Optional model override:
AGENTIC_EVAL_MODEL=gpt-6-astra npm run eval:live
```

This runs two constrained fact-extraction tasks after context preparation and
reports observed answers, provider token usage, and elapsed time as JSON.
Credentials are not needed by ordinary tests. These two tasks are a smoke test,
not a general coding-agent benchmark. Prepared token estimates and provider
token counts use different accounting and should not be treated as identical.

## Adapter conformance

`@nucleic-se/agentic/testing` exports `assertProviderConformance` and
`assertSessionStoreConformance`. Both return a list of passed checks and throw
on failure; they do not require Vitest. Use disposable fixtures only.

```ts
import { assertSessionStoreConformance } from '@nucleic-se/agentic/testing';
import { MemorySessionStore } from '@nucleic-se/agentic/harness';

await assertSessionStoreConformance(() => ({ store: new MemorySessionStore() }));
```

Persistent stores can supply `reopen()` to test state and events across close
and reopen, and `dispose()` to remove test resources. Checks cover copy isolation,
duplicate rejection, atomic state/event commits, competing revisions, event
cursors, and list pagination.

Provider fixtures supply a real adapter backed by an injected fake transport
for each `turn`, `structured`, `truncated`, and `blocked` scenario. They expose
normalized transport calls and a `started` promise for cancellation barriers.
Checks cover response shape, usage, output limits, parseable-but-truncated
structured output, and cancellation before and during transport. See
`runtime/testing/conformance.test.ts` for concrete fixtures. This validates
adapter contracts, not the upstream service's availability or behavior.

`@nucleic-se/agentic/evaluation` exports `runContextEvaluation` and
`contextEvaluationCases` for running the corpus against another context composer.

## Independent runtime proof

Gears' separate `examples/agentic-harness` package composes the public context
and execution primitives with its own queue, worker, scheduled-job registrar,
and application-owned transactional journal. It does not use Agentic's bundled
harness host. Gears remains an infrastructure library without an Agentic core
dependency. The example handles one model turn per task; it is intentionally
not yet a conversational, tool-using replacement for the shipped harness.
