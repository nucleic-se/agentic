# Optional capabilities

Agentic's empty host installs no tools, provider, context policy, storage or UI. Applications select those roles explicitly. The coding preset is a separate, useful composition.

| Import | Purpose |
|---|---|
| `@nucleic-se/agentic/harness/core` | Empty host, driver composition and execution contracts |
| `@nucleic-se/agentic/harness/loops` | Conversational and planning loops |
| `@nucleic-se/agentic/harness/context` | Full-history and budgeted context strategies |
| `@nucleic-se/agentic/coding` | Coding tools, context and default composition |
| `@nucleic-se/agentic/skills` | Explicit skills snapshot and read tool |
| `@nucleic-se/agentic/delegation` | Bounded read-only workers using fresh sessions |
| `@nucleic-se/agentic/browser` | Browser tools using a caller-supplied Playwright-compatible browser |
| `@nucleic-se/agentic/harness/terminal` | Detachable interactive terminal |

The existing `/harness` entry point remains a compatibility facade and includes the coding preset. Use `/harness/core` for the narrow dependency graph. Importing an addon does not discover files, launch a browser, acquire credentials or start a UI. Browser libraries are not Agentic dependencies.

## Skills

The `/skills` addon reads SKILL.md instructions through `read_skill`. The older
`SkillToolRuntime` exported from `/tools` serves a different purpose: it loads
JavaScript skill modules during discovery and executes them through `skill_run`.
Use the addon below for instruction-only skills.

```ts
import { loadSkills } from '@nucleic-se/agentic/skills';
import { createDefaultAgent } from '@nucleic-se/agentic/coding';

const skills = await loadSkills({ directories: ['/project/skills'] });
const agent = await createDefaultAgent({ workspace: '/project', skills });
try {
  const session = await agent.create();
  await agent.submit(session.id, 'Review the changes', { commandId: 'review-1' });
  await agent.wait(session.id);
} finally {
  await agent.close();
}
```

Select a directory containing `SKILL.md`, or a catalog whose immediate child directories contain `SKILL.md`. Discovery is explicit and one level deep. Duplicate names fail. Files must be regular UTF-8 files, at most 64 KiB each; catalogs are bounded to 100 skills and 1 MiB. Symbolic-link skill files and child directories are not followed. Caller-selected directory roots are canonicalized.

Frontmatter requires `name` and `description`. Names use lowercase letters/digits separated by hyphens, up to 64 characters. Descriptions allow 1024 characters. The deliberately small metadata reader supports plain scalar values, JSON-style double quotes, YAML-style single quotes, inline comments, plain continuation lines and `>`/`|` blocks. It is not a general YAML interpreter: tags, aliases, complex mappings and YAML-specific double-quote escapes are not supported in these fields. Other frontmatter fields never install tools or grant permissions.

Only names and descriptions enter the prepared context. The model uses `read_skill({ name, offset? })` to load instructions through normal tool receipts, following `nextOffset` until `eof`. Catalog content and source paths are hashed into the composition identity. The snapshot remains unchanged if files are edited later; explicitly load another snapshot for a new composition.

The default coding policy allows `read_skill` like other known local reads. A custom host retains its own policy. Loading a skill never executes its scripts or expands the tool grant.

For an application-owned composition, reuse ordinary runtimes and context inputs:

```ts
import { CompositeToolRuntime } from '@nucleic-se/agentic/tools';
import { codingToolRuntime, codingAgentContext } from '@nucleic-se/agentic/coding';
import { skillToolRuntime, skillCatalogText } from '@nucleic-se/agentic/skills';

const tools = new CompositeToolRuntime([
  codingToolRuntime(workspace),
  skillToolRuntime(skills),
]);
const context = codingAgentContext({
  workspace,
  tokenBudget: 32000,
  additionalInstructions: skillCatalogText(skills),
});
```

Give one extension ownership of the resulting `tools` role, and one the `context` role. Include `skills.identity` in their non-secret configuration. Supplemental instructions enter before budgeting, never after request preparation. Context overrides used for maintenance retain their existing behavior.

## Browser

Install a compatible Playwright driver in the consuming application, not in Agentic core. Playwright's `locator().ariaSnapshot()` requires version 1.49 or later; install browser binaries separately using that driver's normal workflow.

```ts
import { chromium } from 'playwright';
import { browserToolRuntime } from '@nucleic-se/agentic/browser';
import { createDefaultAgent } from '@nucleic-se/agentic/coding';

const agent = await createDefaultAgent({
  workspace,
  additionalTools: () => browserToolRuntime({
    browser: () => chromium.launch({ headless: true }),
  }),
  additionalToolsIdentity: 'playwright-chromium-v1:headless:default-limits',
});
// Use the agent, then await agent.close().
```

`additionalTools` is an owned factory. It runs during tool-role initialization, and its runtime is closed during rollback or normal shutdown. Combine several runtimes with `CompositeToolRuntime` when needed; duplicate tool names fail. The caller supplies an identity reflecting implementation and relevant non-secret configuration, including driver version for reproducible comparisons.

Browser tools provide navigation, click, fill, accessibility snapshot and viewport screenshot. The host supplies `sessionId`; each session gets its own context/page. Calls within a browser session are sequential. Default limits: 30 seconds per call, 16000 UTF-8 bytes per snapshot, 2 MiB per screenshot and 32 session contexts. Snapshot/capture output limits apply after the driver creates the result, not to internal browser memory.

A supplied browser object is borrowed; a factory-created browser is owned. Contexts are always owned. Closing the runtime releases its contexts and any owned browser. `closeSession(id)` explicitly discards idle browser state and frees capacity. Interrupted sessions are quarantined; reconcile external effects through the host before discarding browser state or trying again. A new session starts with a fresh browser context after restart, never replayed actions.

All browser tools conservatively declare write effects and use the existing approval policy. Screenshots use native image blocks through both hosts. This is browser automation, not network isolation: the application controls URLs, browser credentials and execution environment. Driver acquisition/cleanup must eventually settle for shutdown to drain.

## Gears

Gears retains its own queues, task state, admission and persistence. It consumes the same tool runtimes:

```ts
const runtime = new CompositeToolRuntime([
  skillToolRuntime(skills),
  browserToolRuntime({ browser: () => chromium.launch() }),
]);
const host = await StandaloneHarness.open({
  dataDir, provider, contextTokens: 32000,
  toolRuntime: runtime,
  composition: `skills:${skills.identity};browser:playwright-chromium-v1`,
  projectInstructions: async () => skillCatalogText(skills),
});
try {
  // Create and run tasks through the Gears client.
} finally {
  await host.close();
}
```

Passing `toolRuntime` transfers ownership immediately, including failed startup. Every tool must declare `effectFor`; names must not collide with Gears internal tools or other configured tools. The host drains workers before disposing the shared runtime. Existing `tools` arrays remain caller-owned. When combining skill metadata with existing project instructions, preserve both in the context callback.

## Terminal

```ts
import { startTerminalUi } from '@nucleic-se/agentic/harness/terminal';
const detach = await startTerminalUi(agent, { workspace });
// Later: detach() leaves agent runs alive; agent.close() owns shutdown.
```

- `/sessions [query]`: search the latest 1000 sessions; display up to 50 matches.
- `/use ID`: attach to a session without resuming it.
- `/status`: inspect state, token usage, queue, approvals and uncertain operations.
- `/files [name or glob]`: bounded workspace discovery when `workspace` is supplied.
- `/file PATH`: stage a paths-only reference for the next message; no file body is silently attached. Existing search exclusions apply.

The reference CLI accepts `--skills PATH` and enables workspace discovery in its terminal. Existing commands remain available. Image paste is deliberately separate: `SessionClient.submit` still accepts text, so adding image input requires a tested multimodal submission contract. Gears task-tree navigation remains its own UI concern.

## Delegation

`@nucleic-se/agentic/delegation` supplies an optional, awaited `delegate` tool.
It creates fresh ordinary Agentic sessions for application-defined read-only
workers. It installs nothing in the default harness and does not change the
existing supervisor/worker graph pattern.

```ts
import { delegationToolRuntime } from '@nucleic-se/agentic/delegation';
import { createDefaultAgent, codingToolRuntime } from '@nucleic-se/agentic/coding';

// provider is application-owned; explicitly share its model/settings with workers.
const agent = await createDefaultAgent({
  workspace,
  provider,
  additionalToolsIdentity: 'review-workers-v1', // Include effective configuration changes.
  additionalTools: () => delegationToolRuntime({
    workers: {
      reviewer: {
        description: 'Inspect code and identify concrete correctness issues',
        system: 'Review the assigned code. Cite files and evidence. Do not edit.',
        provider,
        tools: () => codingToolRuntime(workspace, { readOnly: true }),
      },
    },
    maxModelCalls: 30,
    maxConcurrent: 2,
    workerModelCalls: 10,
    // Optional evidence sink, awaited before the session is closed:
    onResult: (record, origin) => saveWorkerEvidence(record, origin),
  }),
});
// Use normal create/submit/wait/close lifecycle. The default parent policy asks
// approval for delegate, as for other unfamiliar tools. A custom parent policy
// may explicitly allow it. Children have no approval flow or mutation tools.
```

The model calls `delegate({ tasks: [{ worker: 'reviewer', prompt: 'Inspect the
transport cancellation paths' }] })`. Tasks return in submission order. Each
result contains terminal status, a bounded answer, truncation flag, reported
usage and its completeness, admitted model calls, dispatched tool calls, elapsed
time and any error. Mixed failures make the overall tool result unsuccessful;
useful partial text does not turn a failed child into a success. `onResult`
receives the full native session record and parent session/call identity for
application-owned evidence storage. Without that sink, child records are
in-memory and released after the call. Error text is bounded too.

Worker tools are explicit, fresh, owned runtimes. Omitting the factory means no
tools. Every discovered tool must declare `effectFor(name) === 'read'`;
`delegate` itself is rejected, and the child policy checks the allowlist again
at dispatch. These declarations are trusted application code, not an OS sandbox.
Use the actual read-only coding runtime to exclude shell and editing from both
discovery and dispatch. Separate conversations do not isolate the filesystem.
No parent transcript, credentials discovery, memory, skills or project instruction
discovery is added automatically; supply the intended worker instructions and
borrowed provider explicitly.

The shared allowance is scoped to this addon instance's lifetime, across all
batches and parents using it. It counts admitted child provider calls, including
failed/cancelled dispatches, without refunds. It **excludes parent calls and
adapter-internal retries** and is not a token or monetary spending limit.
`contextTokens` bounds estimated context per request, not cumulative usage.
Usage is the native session’s reported total. Completeness is conservative: it
requires a validated completed/partial response for every admitted call. A
protocol error carrying usage can therefore contribute to the reported total
while completeness remains false. Missing receipts never imply a known zero cost. To
benchmark a whole agent tree, meter parent and child transports together.
Creating another addon starts another allowance; do not recreate it per tool call.

Defaults are two concurrent children, at most that many tasks per batch, ten
model calls and thirty tool calls per child, a two-minute deadline, 32k context,
2048 reserved output tokens and 6000 characters per returned answer/error.
Concurrency admission covers all batches in the instance. An oversized or busy
batch is rejected before creating any child; there is no hidden task queue.
Invalid or duplicate tasks are rejected before execution.

Parent cancellation and addon shutdown stop new admission, signal children and
wait for their work and owned resources to drain. Tool factories receive an abort
signal. Cancellation is cooperative: a provider or factory that ignores its
signal can delay completion. Evidence sinks and resource cleanup must also
eventually settle, because they participate in draining. Timeout/interruption remain unsuccessful results;
there is no promise of forcibly terminating in-process application code. The
addon closes child tools/sessions but never closes the borrowed provider.
Background handles, messaging, nesting, automatic worktrees and merging are not
part of this addon.
