# State graphs

The core abstraction in `@nucleic-se/agentic` is a **state graph** — a directed graph where nodes are async functions that share a single typed state object. The engine starts at the entry node and follows edges until it reaches `END`.

---

## State shape

Define your state as a plain TypeScript type. Every field must be serialisable (no class instances, no functions):

```ts
type ResearchState = {
  topic: string;
  sources: string[];
  summary: string;
  done: boolean;
};
```

---

## Building a graph

`StateGraphBuilder` is the fluent API for assembling graphs:

```ts
import { StateGraphBuilder, END } from '@nucleic-se/agentic/runtime';

const engine = new StateGraphBuilder<ResearchState>()
  .addNode(fetchNode)
  .addNode(summarizeNode)
  .addNode(doneNode)
  .setEntry('fetch')
  .addEdge('fetch', 'summarize')
  .addEdge('summarize', 'done')
  .addEdge('done', END)
  .build({ maxSteps: 50 });
```

`build()` returns an `IGraphEngine<TState>`. Call `.run(initialState)` to execute:

```ts
const { state, stepsTaken, deadLetters } = await engine.run({
  topic: 'TypeScript',
  sources: [],
  summary: '',
  done: false,
});
```

---

## Node types

### `CallbackGraphNode`

Wraps a plain async function. Mutate `state` in place — no return value needed:

```ts
import { CallbackGraphNode } from '@nucleic-se/agentic/runtime';

const parseNode = new CallbackGraphNode<ResearchState>('parse', async (state, ctx) => {
  state.sources = state.rawText.split('\n').filter(Boolean);
  // ctx.nodeId, ctx.stepCount, ctx.tracer are also available
});
```

### `LlmGraphNode`

Makes an LLM call and writes the result to a state field:

```ts
import { LlmGraphNode } from '@nucleic-se/agentic/runtime';

const summarize = new LlmGraphNode<ResearchState>({
  id: 'summarize',
  provider: llm,
  prompt: (state) => ({
    instructions: 'Summarize the sources into 3 bullet points.',
    text: state.sources.join('\n'),
  }),
  outputKey: 'summary',
  // Optional:
  model: 'claude-sonnet-4-6',
  temperature: 0.3,
  toolRuntime: myTools,  // Give the LLM tools to call
});
```

When `prompt()` returns a `schema`, the node calls `provider.structured()` for typed JSON output. Without a schema it calls `provider.turn()` and writes the assistant's text.

### `SubGraphNode`

Nests an entire `IGraphEngine` as a single node. Use this to compose modular sub-agents:

```ts
import { SubGraphNode } from '@nucleic-se/agentic/runtime';

const researchStep = new SubGraphNode<OuterState, ResearchState>({
  id: 'research',
  engine: researchEngine,
  // Map parent → sub-graph input
  input: (outer) => ({ topic: outer.task, sources: [], summary: '', done: false }),
  // Merge sub-graph output → parent
  output: (sub, outer) => { outer.researchSummary = sub.summary; },
});
```

For deferred initialisation (e.g. when the sub-engine depends on parent state), `engine` accepts a factory:

```ts
engine: (parentState) => buildResearchEngine(parentState.config),
```

---

## Edges

### Static edge

Always routes from one node to another:

```ts
.addEdge('fetch', 'summarize')
```

### Conditional edge

Routes based on state. Return a node ID or `END`:

```ts
.addConditionalEdge('validate', (state) => {
  if (state.errors.length > 0) return 'fix';
  if (state.attempts >= 3)     return END;
  return 'publish';
})
```

Routers can also be `async`:

```ts
.addConditionalEdge('route', async (state) => {
  const decision = await classify(state.input);
  return decision.category;
})
```

### Parallel edge

Fan out to multiple nodes, then merge results before continuing:

```ts
import type { ParallelEdge } from '@nucleic-se/agentic/contracts';

const edge: ParallelEdge<MyState> = {
  targets: ['fetchNews', 'fetchDocs', 'fetchCode'],
  merge: (results, original) => ({
    ...original,
    news:  results[0].news,
    docs:  results[1].docs,
    code:  results[2].code,
  }),
  next: 'synthesize',
};

.addParallelEdge('dispatch', edge)
```

---

## Cycles and loops

Graphs support cycles — just route an edge back to an earlier node:

```ts
.addConditionalEdge('check', (state) =>
  state.quality < 0.8 ? 'generate' : END
)
```

Use `maxSteps` in `build()` to prevent infinite loops:

```ts
.build({ maxSteps: 20 })
```

---

## GraphEngineConfig

| Field | Type | Default | Description |
|---|---|---|---|
| `maxSteps` | `number` | `100` | Hard ceiling on node executions |
| `tracer` | `ITracer` | — | Observability hook |
| `correlationId` | `string` | auto | Propagated to all trace events |
| `limits` | `OrchestratorLimits` | — | Token / time / tool-call caps |
| `onBeforeNode` | `(nodeId, state) => void` | — | Called before each node |
| `onAfterNode` | `(nodeId, state) => void` | — | Called after each node |

```ts
.build({
  maxSteps: 50,
  correlationId: 'session-abc',
  limits: { maxTotalTokens: 100_000, maxDurationMs: 30_000 },
  onAfterNode: (id, state) => console.log(`[${id}]`, state),
})
```

---

## Checkpoints and resume

Save mid-run state and resume from it:

```ts
// In one process / request:
const engine = builder.build();
const checkpoint = await engine.checkpoint();
await saveToDb(checkpoint);

// Later, in another process / request:
const saved = await loadFromDb();
const { state } = await engine.resume(saved);
```

---

## GraphRunResult

```ts
interface GraphRunResult<TState> {
  state: TState;                  // Final state after execution
  stepsTaken: number;             // Total node executions
  deadLetters: GraphDeadLetter[]; // Nodes that threw — { nodeId, error, state }
}
```

Dead letters let you inspect failures without crashing the run:

```ts
const { state, deadLetters } = await engine.run(initial);
if (deadLetters.length) {
  console.error('Failed nodes:', deadLetters.map(d => d.nodeId));
}
```

---

## Implementing `IGraphNode` directly

If the built-in nodes don't fit, implement the interface yourself:

```ts
import type { IGraphNode, GraphContext, GraphState } from '@nucleic-se/agentic/contracts';

class MyNode<TState extends GraphState> implements IGraphNode<TState> {
  readonly id = 'my-node';

  async process(state: TState, ctx: GraphContext<TState>): Promise<void> {
    ctx.reportTokens(500);      // Optional: track LLM usage
    ctx.reportToolCall();       // Optional: track tool calls
    (state as any).result = await doWork(state);
  }
}
```
