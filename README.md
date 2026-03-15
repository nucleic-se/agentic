# @nucleic-se/agentic

Lean, domain-agnostic primitives for building LLM agents: prompt composition, state graphs, tool runtimes, memory, and LLM providers.

## Install

```bash
npm install @nucleic-se/agentic
```

Requires `zod ^4.0.0` as a peer dependency.

## Package structure

The package ships five named entry points so you import only what you need:

| Entry point | Contents |
|---|---|
| `@nucleic-se/agentic` | Everything below, re-exported |
| `@nucleic-se/agentic/contracts` | TypeScript interfaces only (zero runtime code) |
| `@nucleic-se/agentic/runtime` | Concrete implementations of every contract |
| `@nucleic-se/agentic/patterns` | Pre-built agent workflows (ReAct, RAG, …) |
| `@nucleic-se/agentic/tools` | `IToolRuntime` implementations (fs, fetch, shell, …) |
| `@nucleic-se/agentic/providers` | `ILLMProvider` implementations (Anthropic, OpenAI-compatible, Ollama) |

---

## Core concepts

### State graphs

The central abstraction is a **state graph** — a directed graph where nodes are async functions that read and write a shared state object. Execution starts at the entry node and continues along edges until it reaches the `END` sentinel.

```ts
import { StateGraphBuilder, CallbackGraphNode, END } from '@nucleic-se/agentic/runtime';

type MyState = { count: number };

const engine = new StateGraphBuilder<MyState>()
  .addNode(new CallbackGraphNode('increment', async (state) => ({
    ...state,
    count: state.count + 1,
  })))
  .addEdge('increment', END)
  .setEntry('increment')
  .build();

const result = await engine.run({ count: 0 });
console.log(result.state.count); // 1
```

### LLM nodes

`LlmGraphNode` wraps an `ILLMProvider` call inside a graph node. It renders a prompt template (with `{{state.key}}` substitution), optionally supplies tools, and loops until the model signals `end_turn`.

```ts
import { LlmGraphNode } from '@nucleic-se/agentic/runtime';
import { AnthropicProvider } from '@nucleic-se/agentic/providers';

const llm = new AnthropicProvider({ apiKey: '...', model: 'claude-sonnet-4-6' });

const summarize = new LlmGraphNode('summarize', {
  template: 'Summarize this text in one sentence:\n\n{{state.text}}',
  provider: llm,
  tier: 'balanced',
});
```

### Tools

Tools are first-class typed objects with an input schema, output schema, and trust tier. `IToolRuntime` is the interface an LLM-facing tool loop talks to — it never throws; errors come back as `{ ok: false, content: '...' }`.

```ts
import { CompositeToolRuntime, FsToolRuntime, FetchToolRuntime } from '@nucleic-se/agentic/tools';

const tools = new CompositeToolRuntime([
  new FsToolRuntime({ root: '/workspace' }),
  new FetchToolRuntime(),
]);
```

### LLM providers

All providers implement `ILLMProvider`, which has two methods:

- **`structured<T>(request)`** — single call, JSON schema output, no tools. Use for planning and evaluation.
- **`turn(request)`** — agentic turn that may include tool calls. Caller drives the loop.

```ts
import { AnthropicProvider } from '@nucleic-se/agentic/providers';

const llm = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY!, model: 'claude-sonnet-4-6' });

const result = await llm.structured({
  system: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: 'What is 2+2?' }],
  schema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] },
});
```

### Prompt engine

`PromptEngine` composes prioritised sections into a single prompt under a token budget. Sections are scored by `priority × weight`, with sticky sections always included and non-sticky sections dropped when the budget is exhausted.

```ts
import { PromptEngine } from '@nucleic-se/agentic/runtime';

const engine = new PromptEngine({ tokenBudget: 8_000 });
const prompt = engine.compose([
  { id: 'system',  content: 'You are an expert.',   priority: 100, sticky: true },
  { id: 'history', content: longHistory,             priority: 10  },
  { id: 'task',    content: 'Solve the problem.',    priority: 90  },
]);
```

### Memory

`IMemoryStore` holds four memory types — `working`, `episodic`, `semantic`, `procedural` — each with TTL, confidence, and versioning. The in-memory implementation is `InMemoryStore`.

```ts
import { InMemoryStore } from '@nucleic-se/agentic/runtime';

const memory = new InMemoryStore();
await memory.write({ id: '1', type: 'working', key: 'context', value: '...', version: 1 });
const items = await memory.query({ type: 'working' });
```

---

## Pre-built patterns

Every pattern is a factory that returns an `IGraphEngine`. Compose them via `SubGraphNode`.

### ReAct

Reason → Act → Observe loop. Standard tool-augmented reasoning.

```ts
import { createReActAgent } from '@nucleic-se/agentic/patterns';

const agent = createReActAgent({
  provider: llm,
  tools,
  maxIterations: 10,
});

const { state } = await agent.run({ goal: 'Find the capital of France.' });
console.log(state.answer);
```

### Plan-Execute

Decompose a problem into a plan, execute each step, then verify.

```ts
import { createPlanExecuteAgent } from '@nucleic-se/agentic/patterns';

const agent = createPlanExecuteAgent({ provider: llm, tools, maxSteps: 20 });
const { state } = await agent.run({ problem: 'Migrate the users table to PostgreSQL.' });
```

### Reflection

Generate an attempt, reflect on it, and refine until satisfied or `maxAttempts` is reached.

```ts
import { createReflectionAgent } from '@nucleic-se/agentic/patterns';

const agent = createReflectionAgent({ provider: llm, maxAttempts: 3 });
const { state } = await agent.run({ problem: 'Write a haiku about winter.' });
console.log(state.refined);
```

### RAG

Retrieve relevant documents, augment the context, then generate a grounded answer.

```ts
import { createRAGAgent } from '@nucleic-se/agentic/patterns';

const agent = createRAGAgent({
  provider: llm,
  retriever: async (query) => myVectorStore.search(query),
});
const { state } = await agent.run({ query: 'What does the refund policy say?' });
```

### Chain-of-Thought

Stepwise reasoning before a final conclusion.

```ts
import { createChainOfThoughtAgent } from '@nucleic-se/agentic/patterns';

const agent = createChainOfThoughtAgent({ provider: llm });
const { state } = await agent.run({ problem: 'Is 17 a prime number?' });
```

### Supervisor-Worker

A supervisor delegates sub-tasks to multiple worker agents and synthesises their results.

```ts
import { createSupervisorAgent } from '@nucleic-se/agentic/patterns';

const agent = createSupervisorAgent({
  provider: llm,
  workers: [researchAgent, writingAgent, reviewAgent],
});
const { state } = await agent.run({ problem: 'Write a market analysis report.' });
```

### Human-in-the-Loop

Pause execution to collect human input at decision points.

```ts
import { createHumanInLoopAgent } from '@nucleic-se/agentic/patterns';

const agent = createHumanInLoopAgent({
  provider: llm,
  humanInputFn: async (prompt) => {
    process.stdout.write(prompt + '\n> ');
    return readlineInput();
  },
});
const { state } = await agent.run({ problem: 'Should we proceed with the migration?' });
```

---

## Tool runtimes

All runtimes implement `IToolRuntime`. Combine them with `CompositeToolRuntime`.

| Runtime | Tools exposed | Notes |
|---|---|---|
| `FsToolRuntime` | `fs_read`, `fs_write`, `fs_delete`, `fs_list`, `fs_move` | Root-relative paths; 256 KB read/write limit |
| `FetchToolRuntime` | `fetch_json`, `fetch_text`, `fetch_head` | Retry + timeout; body size limits |
| `ShellToolRuntime` | `shell_exec` | Timeout + output size cap |
| `SearchToolRuntime` | `search_files` | Regex + glob across a directory tree |
| `SkillToolRuntime` | `skill_invoke` | Invokes Claude Code skills |
| `WebToolRuntime` | `web_fetch`, `web_metadata` | Fetches + parses HTML to markdown |

```ts
import {
  CompositeToolRuntime, FsToolRuntime, FetchToolRuntime, ShellToolRuntime,
} from '@nucleic-se/agentic/tools';

const runtime = new CompositeToolRuntime([
  new FsToolRuntime({ root: process.cwd() }),
  new FetchToolRuntime({ timeoutMs: 10_000 }),
  new ShellToolRuntime({ timeoutMs: 30_000 }),
]);
```

---

## LLM providers

All providers implement `ILLMProvider`.

### AnthropicProvider

```ts
import { AnthropicProvider } from '@nucleic-se/agentic/providers';

const llm = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-sonnet-4-6',
  temperature: 0.2,
});
```

### OpenAICompatibleProvider

Works with OpenAI, Azure OpenAI, and any OpenAI-compatible endpoint (vLLM, LM Studio, etc.).

```ts
import { OpenAICompatibleProvider } from '@nucleic-se/agentic/providers';

const llm = new OpenAICompatibleProvider({
  baseURL: 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o',
});
```

### OllamaProvider

Local inference via Ollama. Defaults to `localhost:11434`.

```ts
import { OllamaProvider } from '@nucleic-se/agentic/providers';

const llm = new OllamaProvider({ model: 'llama3.2' });
```

---

## Building a custom agent

Below is a minimal end-to-end example that builds a coding agent from scratch using only primitives.

```ts
import { StateGraphBuilder, LlmGraphNode, CallbackGraphNode, END } from '@nucleic-se/agentic/runtime';
import { AnthropicProvider } from '@nucleic-se/agentic/providers';
import { CompositeToolRuntime, FsToolRuntime, ShellToolRuntime } from '@nucleic-se/agentic/tools';

type AgentState = {
  task: string;
  code: string;
  testOutput: string;
  done: boolean;
};

const llm = new AnthropicProvider({ apiKey: '...', model: 'claude-sonnet-4-6' });
const tools = new CompositeToolRuntime([
  new FsToolRuntime({ root: '/workspace' }),
  new ShellToolRuntime(),
]);

const engine = new StateGraphBuilder<AgentState>()
  .addNode(new LlmGraphNode('write', {
    template: 'Write code that solves: {{state.task}}',
    provider: llm,
    toolRuntime: tools,
  }))
  .addNode(new CallbackGraphNode('check', async (state) => ({
    ...state,
    done: state.testOutput.includes('PASS'),
  })))
  .addEdge('write', 'check')
  .addConditionalEdge('check', (state) => state.done ? END : 'write')
  .setEntry('write')
  .build({ maxSteps: 20 });

const { state } = await engine.run({ task: 'FizzBuzz', code: '', testOutput: '', done: false });
```

---

## Graph API reference

### `StateGraphBuilder<TState>`

```ts
.addNode(node: IGraphNode<TState>)                              // register a node
.addEdge(from: string, to: string | END)                        // static edge
.addConditionalEdge(from: string, router: RouterFn<TState>)     // dynamic routing
.addParallelEdge(from: string, edge: ParallelEdge<TState>)      // fan-out/merge
.setEntry(nodeId: string)                                       // entry point
.build(config?: GraphEngineConfig)                              // → IGraphEngine
```

### `GraphEngineConfig`

| Field | Type | Default | Description |
|---|---|---|---|
| `maxSteps` | `number` | `100` | Hard ceiling on node executions |
| `tracer` | `ITracer` | — | Observability hook |
| `correlationId` | `string` | — | Propagated to all trace events |
| `limits` | `OrchestratorLimits` | — | Token/time/tool-call caps |
| `onBeforeNode` | `fn` | — | Called before each node |
| `onAfterNode` | `fn` | — | Called after each node |

### `IGraphEngine<TState>`

```ts
run(initialState: TState): Promise<GraphRunResult<TState>>
step(state: TState, nodeId: string): Promise<TState>
checkpoint(): Promise<GraphCheckpoint<TState>>
resume(checkpoint: GraphCheckpoint<TState>): Promise<GraphRunResult<TState>>
```

### Node types

| Class | Purpose |
|---|---|
| `CallbackGraphNode` | Wraps an `async (state, ctx) => state` function |
| `LlmGraphNode` | LLM call with optional tool loop |
| `SubGraphNode` | Nests another `IGraphEngine` as a single node |

---

## Contracts

All interfaces live in `@nucleic-se/agentic/contracts` and carry zero runtime code. Use them to type your own implementations or to keep your domain code provider-agnostic.

| Interface | Description |
|---|---|
| `ILLMProvider` | `structured()` + `turn()` |
| `IToolRuntime` | `tools()` + `call(name, args)` |
| `ITool<I,O>` | Typed tool with schema + trust tier |
| `IToolRegistry` | `register()` / `resolve()` / `list()` |
| `IMemoryStore` | 4-tier memory with TTL and write validation |
| `IPromptEngine` | `compose(sections, budget?)` |
| `IGraphEngine<S>` | `run()` / `step()` / `checkpoint()` / `resume()` |
| `IGraphBuilder<S>` | Fluent builder → `IGraphEngine` |
| `IGraphNode<S>` | `id` + `process(state, ctx)` |
| `ITracer` | `record(event)` + `span(name, fn)` |

---

## License

ISC
