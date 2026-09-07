# @nucleic-se/agentic

Lean, domain-agnostic TypeScript primitives for building LLM agents: state graphs, LLM providers, tool runtimes, tool policy, prompt composition, context assembly, memory, and capability primitives.

Our [north star](docs/north-star.md) defines the shared Agentic/Gears direction:
composable foundations, useful context and simple, maintainable code before feature breadth.

```bash
npm install @nucleic-se/agentic
```

Requires `zod ^4.0.0` as a peer dependency and Node ≥ 20.18.1.

## Composable harness and reference agent

The feature-branch harness is an empty extension host with explicit `store`,
`loop`, `context`, `provider`, `tools`, and `policy` roles. Constructing the host
performs no initialization. The reference agent supplies these roles and can
attach a terminal UI, browser UI, or your own `SessionClient` consumer.

From this checkout:

```bash
npm install
npm run build
npm run agent -- --workspace /absolute/path/to/project
```

The reference agent uses your existing local Codex subscription authentication
(`$CODEX_HOME/auth.json`, otherwise `~/.codex/auth.json`). No API key is needed.
Its default model is `gpt-6-astra`; this configuration was verified with a live
subscription request during development. Use `--model NAME` or `AGENTIC_MODEL`
to select another model available to your account. Credentials remain on the host.

Sessions persist in `~/.agentic/sessions.sqlite`; change the directory with
`--data /absolute/path`. For the durable demo, use Node 22.13+ or a later release
with `node:sqlite` enabled. Older supported Node versions need a compatible,
separately installed `better-sqlite3`; it is loaded only when built-in SQLite is
unavailable. The base library and in-memory harness retain Node 20.18.1 support.
See [Node's SQLite version history](https://nodejs.org/api/sqlite.html).

Terminal commands are `/new [title]`, `/sessions`, `/resume SESSION_ID`, `/fork`,
`/cancel`, `/approve APPROVAL_ID y|n`, and `/quit`. Ordinary input during a run
steers the agent at its next safe boundary. Read tools are allowed; file mutations
and shell commands require approval. `--planning` selects a separate planning
model operation before the conversational loop. `/quit` detaches the terminal;
UI detachment is not cancellation.

### Browser and phone on the same Wi-Fi

```bash
npm run agent:web -- --workspace /absolute/path/to/project --host 0.0.0.0
```

Open the printed **Network address** on a phone connected to the same trusted
Wi-Fi. Read the login token from `~/.agentic/web-token` (or `DATA/web-token` when
using `--data`) and enter it in the browser. Keep the host computer awake and
the agent process running. The default port is 4317; use `--port` to change it.
The server uses local HTTP: do not port-forward it or expose it to the public
internet. Omitting `--host 0.0.0.0` restricts access to localhost. Add `--terminal`
to attach both UIs to the same running host; do not start a second process against
the same database.

### Assemble your own agent

For the subscription backend below, install `@earendil-works/pi-ai@0.85.1`
and use Node >=22.19. The core remains independent of this optional backend.

```ts
import {
  createHarness, MemorySessionStore, conversationalLoop,
  fullHistoryContext, codingToolRuntime, defaultCodingPolicy,
} from '@nucleic-se/agentic/harness';
import { SubscriptionProvider } from '@nucleic-se/agentic/providers/subscription';
import { terminalUiExtension } from '@nucleic-se/agentic/harness/terminal';

const client = await createHarness().compose({
  extensions: [
    {
      id: 'my.agent', version: '1.0.0', apiVersion: 1,
      roles: {
        store: () => new MemorySessionStore(),
        loop: () => conversationalLoop({ maxTurns: 20 }),
        context: () => fullHistoryContext('Inspect, implement, and verify changes.'),
        provider: () => new SubscriptionProvider({ model: 'gpt-6-astra' }),
        tools: () => codingToolRuntime(process.cwd()),
        policy: () => defaultCodingPolicy(),
      },
    },
    terminalUiExtension(),
  ],
});
// When the application shuts down:
// await client.close();
```

Each role can live in its own extension. Duplicate owners and missing roles fail
before factories run. Replace `MemorySessionStore` with
`createSqliteSessionStore(path)` from `@nucleic-se/agentic/harness/sqlite` for
durability. `createDefaultAgent({ workspace, database })` supplies the reference
composition; omit `database` for ephemeral sessions. To replace a preset role,
edit the extension list returned by `await defaultAgentExtensions()` rather than adding
a conflicting owner.

The host journals model/tool effects and commits their transcript projections;
custom loops must not append returned responses or tool results again. An
internal model request can use `{ projection: 'none' }` as its second argument.
Extensions are trusted local code, and shell tools are not a filesystem sandbox.
Recovery never automatically repeats tools with unknown outcomes. See the
[architecture and implementation limits](docs/harness-design.md).

---

## Quick start

```ts
import { StateGraphBuilder, LlmGraphNode, END } from '@nucleic-se/agentic/runtime';
import { AnthropicProvider } from '@nucleic-se/agentic/providers/subscription';

type State = { topic: string; summary: string };

const llm = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY!, model: 'claude-sonnet-4-6' });

const engine = new StateGraphBuilder<State>()
  .addNode(new LlmGraphNode<State>({
    id: 'summarize',
    provider: llm,
    prompt: (s) => ({ instructions: 'Summarize in one sentence.', text: s.topic }),
    outputKey: 'summary',
  }))
  .setEntry('summarize')
  .addEdge('summarize', END)
  .build();

const { state } = await engine.run({ topic: 'Quantum entanglement', summary: '' });
console.log(state.summary);
```

---

## Documentation

| Guide | Description |
|---|---|
| [Getting started](docs/getting-started.md) | Install, first agent, common patterns |
| [State graphs](docs/concepts/graphs.md) | Nodes, edges, routing, parallel fan-out |
| [LLM providers](docs/concepts/providers.md) | Anthropic, OpenAI-compatible, Codex subscription, Ollama |
| [Tool runtimes](docs/concepts/tools.md) | Filesystem, fetch, shell, search, custom tools |
| [Agent kernel](docs/concepts/kernel.md) | Bounded turns, batch preflight, policy, cancellation |
| [Composable harness](docs/harness-design.md) | Extension roles, sessions, execution effects, UI, and current limits |
| [Ivy runtime boundary](docs/ivy-runtime-boundary.md) | Ownership and migration contract for Ivy's future Agentic runtime |
| [Tool policy](docs/concepts/tool-policy.md) | Allow/deny/rewrite/confirm before execution |
| [Memory](docs/concepts/memory.md) | Working, episodic, semantic, procedural memory |
| [Prompt engine](docs/concepts/prompts.md) | Priority-weighted composition under a token budget |
| [Capabilities](docs/concepts/capabilities.md) | Prompt, tools, and lifecycle bundled as a composable unit |
| [Context assembly](docs/concepts/context-assembly.md) | Selecting what the model sees each turn |
| [Pre-built patterns](docs/guides/patterns.md) | ReAct, Plan-Execute, RAG, Reflection, Supervisor, Router, Map-Reduce |
| [Building a custom agent](docs/guides/custom-agent.md) | End-to-end walkthrough |
| [API reference](docs/api-reference.md) | All exported types and classes |

---

## Current surface

Recent additions:

- `IPackRegistry` / `PackRegistry` replace the old capability-registry naming for pack wiring
- `RuntimeSchema<T>` keeps provider JSON Schema and runtime validation together
- `ToolRuntimeAdapter` validates and dispatches `ITool[]`; policy stays in the kernel
- `runAgentKernel` provides a public alpha turn loop with whole-batch preflight
- `AgentContextAssembler` now uses grouped, compress-before-drop conversation pruning
- `ICapability<TState>` / `ICapabilityLifecycle<TState>` define the minimal Wave 2 capability contract
- `PlanningCapability`, `BudgetHintCapability`, and `EmptyResponseCapability` ship as concrete default capabilities
- `createRouterAgent` and `createMapReduceAgent` add lightweight routing and fan-out/fan-in graph patterns

---

## Package structure

| Entry point | Contents |
|---|---|
| `@nucleic-se/agentic` | Core contracts, runtimes, patterns, and basic tool adapters |
| `@nucleic-se/agentic/contracts` | Core interfaces, shared protocol errors and constants |
| `@nucleic-se/agentic/runtime` | Concrete implementations |
| `@nucleic-se/agentic/context` | Stateless context selection, contribution and budget primitives |
| `@nucleic-se/agentic/execution` | Model operations, tool batches and atomic journal transitions |
| `@nucleic-se/agentic/kernel` | Narrow kernel and budgeted context composition surface |
| `@nucleic-se/agentic/harness` | Empty extension host, session client, strategies, reference preset |
| `@nucleic-se/agentic/harness/sqlite` | Optional durable SQLite session adapter |
| `@nucleic-se/agentic/harness/terminal` | Detachable terminal UI extension |
| `@nucleic-se/agentic/harness/web` | Authenticated local/LAN browser UI extension |
| `@nucleic-se/agentic/llm` | Narrow provider/message/tool-definition protocols |
| `@nucleic-se/agentic/tool-runtime` | Narrow executable tool-runtime protocols |
| `@nucleic-se/agentic/agent-contracts` | Kernel records, events, plans, and failures |
| `@nucleic-se/agentic/tool-policy` | Tool policy and confirmation-decision protocols |
| `@nucleic-se/agentic/patterns` | Pre-built agent workflows |
| `@nucleic-se/agentic/tools` | Tool runtime implementations |
| `@nucleic-se/agentic/providers` | LLM provider implementations |

See [Composing primitives](docs/composing-primitives.md) for the shared execution and context architecture, a standalone example, and alpha migration notes.

The latest [alpha API migration](docs/alpha-api-migration.md) covers budget-aware builders, atomic context groups, immutable pipelines and operation recovery.

---

## License

ISC
