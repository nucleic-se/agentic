# Getting started

## Install

```bash
npm install @nucleic-se/agentic zod
```

Requires Node ≥ 20.18.1 and `zod ^4.0.0` as a peer dependency.

---

## Your first agent in 5 minutes

### 1. Pick a provider

```ts
import { AnthropicProvider } from '@nucleic-se/agentic/providers';

const llm = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-sonnet-4-6',
});
```

See [LLM providers](./concepts/providers.md) for OpenAI-compatible and Ollama alternatives.

### 2. Build a graph

```ts
import { StateGraphBuilder, LlmGraphNode, CallbackGraphNode, END } from '@nucleic-se/agentic/runtime';

type MyState = {
  question: string;
  answer: string;
  validated: boolean;
};

const engine = new StateGraphBuilder<MyState>()
  // Node 1: ask the LLM
  .addNode(new LlmGraphNode<MyState>({
    id: 'answer',
    provider: llm,
    prompt: (s) => ({
      instructions: 'Answer the question concisely.',
      text: s.question,
    }),
    outputKey: 'answer',
  }))
  // Node 2: validate the result
  .addNode(new CallbackGraphNode<MyState>('validate', async (state) => {
    state.validated = state.answer.length > 0;
  }))
  .setEntry('answer')
  .addEdge('answer', 'validate')
  .addEdge('validate', END)
  .build({ maxSteps: 10 });
```

### 3. Run it

```ts
const { state } = await engine.run({
  question: 'What is the capital of France?',
  answer: '',
  validated: false,
});

console.log(state.answer);    // "Paris"
console.log(state.validated); // true
```

---

## Adding tools

Give the LLM access to external capabilities by attaching a `IToolRuntime`:

```ts
import { CompositeToolRuntime, FsToolRuntime, FetchToolRuntime } from '@nucleic-se/agentic/tools';

const tools = new CompositeToolRuntime([
  new FsToolRuntime({ root: process.cwd() }),
  new FetchToolRuntime({ timeoutMs: 10_000 }),
]);
```

Pass it to `LlmGraphNode` via the `toolRuntime` config field — the LLM can then call tools during its turn:

```ts
new LlmGraphNode<MyState>({
  id: 'research',
  provider: llm,
  prompt: (s) => ({ instructions: 'Research the topic.', text: s.topic }),
  outputKey: 'findings',
  toolRuntime: tools,
})
```

See [Tool runtimes](./concepts/tools.md) for a full breakdown of available runtimes.

---

## Using pre-built patterns

For common agent architectures you don't need to build a graph by hand:

```ts
import { createReActAgent } from '@nucleic-se/agentic/patterns';

const agent = createReActAgent({
  llm,
  tools: {
    search: async (query) => mySearchFn(query),
    calculate: async (expr) => String(eval(expr)),
  },
  maxIterations: 5,
});

const { state } = await agent.run({
  goal: 'What is 15% of 240?',
  thought: '', action: '', actionInput: '', observation: '',
  answer: '', iteration: 0,
});

console.log(state.answer); // "36"
```

Available patterns: [ReAct, Plan-Execute, RAG, Reflection, Chain-of-Thought, Supervisor-Worker, Human-in-the-Loop](./guides/patterns.md).

---

## Routing between nodes

Use conditional edges to branch on state:

```ts
.addConditionalEdge('validate', (state) => {
  if (state.validated) return END;
  return state.attempts < 3 ? 'answer' : END; // retry up to 3 times
})
```

---

## Structured output

When you need the LLM to return typed JSON, pass a JSON Schema to `prompt()`:

```ts
prompt: (s) => ({
  instructions: 'Classify the sentiment.',
  text: s.review,
  schema: {
    type: 'object',
    properties: { sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'] } },
    required: ['sentiment'],
  },
}),
outputKey: 'classification',
```

The node calls `provider.structured()` automatically when a schema is present.

---

## Next steps

- [State graphs in depth](./concepts/graphs.md) — parallel edges, sub-graphs, checkpoints
- [Building a custom agent](./guides/custom-agent.md) — full end-to-end walkthrough
- [API reference](./api-reference.md) — all types and classes
