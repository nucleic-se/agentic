# @nucleic-se/agentic

Lean, domain-agnostic TypeScript primitives for building LLM agents: state graphs, LLM providers, tool runtimes, tool policy, prompt composition, context assembly, memory, and capability primitives.

```bash
npm install @nucleic-se/agentic
```

Requires `zod ^4.0.0` as a peer dependency and Node ≥ 20.18.1.

---

## Quick start

```ts
import { StateGraphBuilder, LlmGraphNode, END } from '@nucleic-se/agentic/runtime';
import { AnthropicProvider } from '@nucleic-se/agentic/providers';

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
| `@nucleic-se/agentic/contracts` | TypeScript interfaces only — zero runtime code |
| `@nucleic-se/agentic/runtime` | Concrete implementations |
| `@nucleic-se/agentic/kernel` | Narrow kernel and budgeted context composition surface |
| `@nucleic-se/agentic/llm` | Narrow provider/message/tool-definition protocols |
| `@nucleic-se/agentic/tool-runtime` | Narrow executable tool-runtime protocols |
| `@nucleic-se/agentic/agent-contracts` | Kernel records, events, plans, and failures |
| `@nucleic-se/agentic/tool-policy` | Tool policy and confirmation-decision protocols |
| `@nucleic-se/agentic/patterns` | Pre-built agent workflows |
| `@nucleic-se/agentic/tools` | Tool runtime implementations |
| `@nucleic-se/agentic/providers` | LLM provider implementations |

---

## License

ISC
