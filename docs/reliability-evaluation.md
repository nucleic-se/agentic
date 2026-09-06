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

## Recoverable evidence evaluation

```sh
npm run eval:retention
# Opt-in live model comparison using subscription auth and fixed synthetic evidence:
npm run eval:retention:live
```

The deterministic comparison uses identical source history in three modes: full
payloads, recoverable references, and no retrieval grant. Each runs at generous
and constrained budgets. It checks immutable source data, tool pairs, valid visible
references, grants and ceilings. `answerAvailable` is separate from `passed`:
a baseline can respect its contracts while dropping the requested evidence.
The recovery oracle follows the actual retained reference; it is not a model.
`runRetentionEvaluation` is also exported from `@nucleic-se/agentic/evaluation`.

The live comparison sends the same synthetic archive-code task through shared
harness execution in full and recoverable modes. It permits at most four model
calls per mode, validates retrieval indices, and has no workspace or write tools.
Reports include exact intents/receipts, answer, retrieval count, usage and duration.
The reference mode must actually retrieve the source before passing. Save stdout
outside the repository when retaining run evidence. Model choice is controlled by
`AGENTIC_EVAL_MODEL`, defaulting to `gpt-5.6-terra`.

These tests distinguish request-size reduction from actual model behavior and
end-to-end cost. A single fixed-order model comparison is not a performance study.
The current fixture demonstrated a 5,382-to-1,967 estimated-token reduction;
one live run answered correctly in both modes, using 2,748 input tokens in one
full-context call versus 2,363 across two recovery calls. This is evidence for
that fixture only, not a general efficiency claim.

## Gears composition proof

Gears' separate `examples/agentic-harness` package uses the shared Agentic harness
composer, context and execution contracts with a Gears driver. Gears owns queue,
worker, scheduler and transactional task storage; its core has no Agentic dependency.
The standalone composition supports tools, children, scheduled continuation and
inspection. Its full dogfood scenario uses fresh data and a forced checkpoint
restart. The older one-turn example remains available separately. See the example's
`README.md` and `VALIDATION.md` in the Gears repository for current behavior and limits.
