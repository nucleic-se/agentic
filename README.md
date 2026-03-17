# @nucleic-se/agentic

Lean, domain-agnostic TypeScript primitives for building LLM agents: state graphs, LLM providers, tool runtimes, tool policy, prompt composition, context assembly, and memory.

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
| [LLM providers](docs/concepts/providers.md) | Anthropic, OpenAI-compatible, Ollama |
| [Tool runtimes](docs/concepts/tools.md) | Filesystem, fetch, shell, search, custom tools |
| [Tool policy](docs/concepts/tool-policy.md) | Allow/deny/rewrite/confirm before execution |
| [Memory](docs/concepts/memory.md) | Working, episodic, semantic, procedural memory |
| [Prompt engine](docs/concepts/prompts.md) | Priority-weighted composition under a token budget |
| [Context assembly](docs/concepts/context-assembly.md) | Selecting what the model sees each turn |
| [Pre-built patterns](docs/guides/patterns.md) | ReAct, Plan-Execute, RAG, Reflection, Supervisor |
| [Building a custom agent](docs/guides/custom-agent.md) | End-to-end walkthrough |
| [API reference](docs/api-reference.md) | All exported types and classes |

---

## Package structure

| Entry point | Contents |
|---|---|
| `@nucleic-se/agentic` | Everything re-exported |
| `@nucleic-se/agentic/contracts` | TypeScript interfaces only — zero runtime code |
| `@nucleic-se/agentic/runtime` | Concrete implementations |
| `@nucleic-se/agentic/patterns` | Pre-built agent workflows |
| `@nucleic-se/agentic/tools` | Tool runtime implementations |
| `@nucleic-se/agentic/providers` | LLM provider implementations |

---

## License

ISC
