# @nucleic/agentic

Domain-agnostic primitives for building agentic AI systems. Provides composable prompt assembly, step-based execution pipelines, capability/pack management, fluent LLM builders, state-graph orchestration for LLM agent workflows, migration orchestration, and structured tracing.

Zero domain opinions. Extend via TypeScript generics. One dependency (`zod`, for pipeline validation).

## Install

```bash
npm install @nucleic/agentic
```

## Quick Start

```ts
import {
  PromptEngine,
  AIPromptService,
  StateGraphBuilder,
  CallbackGraphNode,
  LlmGraphNode,
  END,
  TickPipeline,
  CapabilityRegistry,
  estimateTokens,
} from '@nucleic/agentic';
```

## Modules

| Module | Purpose |
|--------|---------|
| **Prompt Engine** | Assemble LLM prompts from scored sections within a token budget |
| **Prompt Contributors** | Plugin system for producing prompt sections from context |
| **Tick Pipeline** | Ordered step execution for simulation/processing loops |
| **AI Builders** | Fluent prompt builder + chainable pipeline with retry/validation |
| **LLM Provider** | Abstract interface for any language model backend |
| **State Graph** | Directed graph engine for LLM agent workflows with shared state |
| **Pack System** | Manifest-based capability registration with dependency validation |
| **Migration Orchestrator** | Run ordered data migrations across packs |
| **Tracer** | Lightweight structured event tracing with ring buffer |
| **Utilities** | Token estimation and shared helpers |

---

## Prompt Engine

Composes a prompt from multiple `PromptSection` objects within a token budget.

**Scoring:** `score = priority × weight × contextMultiplier`

Sticky sections are always included. Non-sticky sections are ranked by score (descending), then by `id` for deterministic tie-breaking. Sections are added until the budget is exhausted.

```ts
import { PromptEngine } from '@nucleic/agentic';
import type { PromptSection } from '@nucleic/agentic';

const engine = new PromptEngine();

const sections: PromptSection[] = [
  {
    id: 'system-instructions',
    priority: 100,
    weight: 1,
    estimatedTokens: 200,
    text: () => 'You are a helpful assistant.',
    tags: ['system'],
    sticky: true,           // always included, never trimmed
  },
  {
    id: 'recent-context',
    priority: 50,
    weight: 1.5,
    estimatedTokens: 400,
    text: () => 'The user asked about TypeScript generics.',
    tags: ['context'],
    contextMultiplier: 2.0, // dynamic boost (e.g. recency)
  },
  {
    id: 'background-lore',
    priority: 10,
    weight: 1,
    estimatedTokens: 300,
    text: () => 'Background information about the project...',
    tags: ['lore'],
  },
];

const result = engine.compose(sections, 800);

console.log(result.text);          // assembled prompt string
console.log(result.totalTokens);   // tokens used
console.log(result.included);      // sections that made the cut
console.log(result.excluded);      // sections trimmed by budget
```

## Prompt Contributors

A plugin system where each contributor produces `PromptSection[]` from a shared context. Register contributors, then collect all sections to feed into the Prompt Engine.

```ts
import { PromptContributorRegistry } from '@nucleic/agentic';
import type { IPromptContributor, PromptContributionContext } from '@nucleic/agentic';

// Define your domain context
interface MyContext extends PromptContributionContext {
  userId: string;
  topic: string;
}

// Create a contributor
const topicContributor: IPromptContributor<MyContext> = {
  id: 'topic',
  contribute(ctx) {
    return [{
      id: 'topic-section',
      priority: 50,
      weight: 1,
      estimatedTokens: 100,
      text: () => `Current topic: ${ctx.topic}`,
      tags: ['topic'],
    }];
  },
};

// Register and collect
const registry = new PromptContributorRegistry<MyContext>();
registry.register(topicContributor);

const context: MyContext = { userId: 'u1', topic: 'TypeScript generics' };
const allSections = await Promise.all(
  registry.list().map(c => c.contribute(context))
).then(arrays => arrays.flat());
```

## Tick Pipeline

Ordered step-based execution pipeline. Each step has an `id`, an `order` (lower runs first), and an async `execute` method. Extend `TickContext` with domain-specific fields via generics.

```ts
import { TickPipeline } from '@nucleic/agentic';
import type { TickContext, ITickStep } from '@nucleic/agentic';

// Extend context for your domain
interface GameContext extends TickContext {
  timeOfDay: string;
  weather: string;
}

const pipeline = new TickPipeline<GameContext>();

const weatherStep: ITickStep<GameContext> = {
  id: 'advance-weather',
  order: 10,
  async execute(ctx) {
    console.log(`Tick ${ctx.tick}: weather is ${ctx.weather}`);
    // mutate world state via injected services
  },
};

const aiStep: ITickStep<GameContext> = {
  id: 'run-ai-decisions',
  order: 20,
  async execute(ctx) {
    console.log(`Tick ${ctx.tick}: running AI...`);
  },
};

pipeline.registerStep(weatherStep);
pipeline.registerStep(aiStep);

// Execute all steps in order
await pipeline.run('sim-1', {
  simulationId: 'sim-1',
  tick: 1,
  timeOfDay: 'morning',
  weather: 'sunny',
  stepState: {},
});
```

## LLM Provider

Abstract interface for language model backends. Implement once for your provider (Ollama, OpenAI, Anthropic, etc.), then use it everywhere.

```ts
import type { ILLMProvider, LLMRequest } from '@nucleic/agentic';

class MyLLMProvider implements ILLMProvider {
  async process<T>(request: LLMRequest<T>): Promise<T> {
    // call your LLM API here
    const response = await fetch('https://api.example.com/generate', {
      method: 'POST',
      body: JSON.stringify({
        system: request.instructions,
        prompt: request.text,
        schema: request.schema,
        model: request.model,
        temperature: request.temperature,
      }),
    });
    return response.json();
  }

  async embed(text: string): Promise<number[]> {
    // call your embedding API
    return [0.1, 0.2, 0.3];
  }
}
```

## AI Prompt Builder & Pipeline

### Fluent Prompt Builder

Build and execute LLM prompts with a chainable API. Takes an `ILLMProvider` directly — no DI container required.

```ts
import { AIPromptService } from '@nucleic/agentic';

const llm = new MyLLMProvider();
const ai = new AIPromptService(llm);

// Simple prompt
const answer = await ai.use()
  .system('You are a helpful coding assistant.')
  .user('Explain TypeScript generics in 3 sentences.')
  .run();

// Structured output with JSON schema
const data = await ai.use('gpt-4')
  .system('Extract entities from the text.')
  .user('Alice met Bob at the park.')
  .schema({
    type: 'object',
    properties: {
      people: { type: 'array', items: { type: 'string' } },
      location: { type: 'string' },
    },
  })
  .run<{ people: string[]; location: string }>();
```

### Chainable Pipeline

Compose multi-step processing chains with retry, Zod validation, LLM calls, and error handling.

```ts
import { z } from 'zod';

const SummarySchema = z.object({
  title: z.string(),
  points: z.array(z.string()),
});

const result = await ai.pipeline('A long article about AI safety...')
  .pipe(async (text) => {
    // preprocessing step
    return text.slice(0, 2000);
  })
  .llm<{ title: string; points: string[] }>((builder) => {
    builder
      .system('Summarize the following text as structured JSON.')
      .schema({
        type: 'object',
        properties: {
          title: { type: 'string' },
          points: { type: 'array', items: { type: 'string' } },
        },
      });
  })
  .retry(3)                        // retry previous step up to 3 times
  .validate(SummarySchema)         // validate with Zod
  .catch((err) => ({               // fallback on failure
    title: 'Error',
    points: [err.message],
  }))
  .run();
```

Pipeline methods:

| Method | Description |
|--------|-------------|
| `.pipe(fn)` | Add a processing step |
| `.llm(configure, model?, options?)` | Add an LLM call step |
| `.retry(n)` | Retry the previous step up to `n` times with backoff |
| `.validate(zodSchema)` | Validate the previous step's output |
| `.transform(fn)` | Transform the previous step's output |
| `.clog(logger, msg?)` | Log the current value for debugging |
| `.catch(handler)` | Handle errors with a fallback |
| `.run(initial?)` | Execute the pipeline |

## State Graph

A directed graph engine for LLM agent workflows. Nodes share a typed mutable state object; edges (static or conditional) determine execution order. Designed for plan → act → observe → decide loops with conditional routing and cycle safety.

**Execution model:** The engine clones the initial state (never mutates the caller's object), runs the entry node, snapshots state after each step, resolves the next edge, and repeats until reaching `END` or exceeding `maxSteps`.

### Building a Graph

Use `StateGraphBuilder` for a fluent API that validates the graph on `build()`.

```ts
import {
  StateGraphBuilder,
  CallbackGraphNode,
  END,
} from '@nucleic/agentic';
import type { GraphState } from '@nucleic/agentic';

interface ResearchState extends GraphState {
  topic: string;
  outline: string;
  draft: string;
  iteration: number;
}

const plan = new CallbackGraphNode<ResearchState>('plan', async (state) => {
  state.outline = `Outline for: ${state.topic}`;
  state.iteration++;
});

const write = new CallbackGraphNode<ResearchState>('write', async (state) => {
  state.draft = `Draft based on: ${state.outline}`;
});

const review = new CallbackGraphNode<ResearchState>('review', async (state) => {
  // review logic — could call an LLM here
  state.iteration++;
});

const engine = new StateGraphBuilder<ResearchState>()
  .addNode(plan)
  .addNode(write)
  .addNode(review)
  .setEntry('plan')
  .addEdge('plan', 'write')
  .addEdge('write', 'review')
  .addConditionalEdge('review', (state) =>
    state.iteration >= 3 ? END : 'plan'
  )
  .build({ maxSteps: 50 });

const result = await engine.run({
  topic: 'quantum computing',
  outline: '',
  draft: '',
  iteration: 0,
});

console.log(result.state.draft);       // final draft
console.log(result.steps);             // total node executions
console.log(result.snapshots.length);  // one snapshot per step
```

### Conditional Routing

A `RouterFn` inspects current state and returns the next node ID, or `END` to stop. The state is passed as `Readonly<TState>` to keep routing decisions pure.

```ts
builder.addConditionalEdge('classify', (state) => {
  if (state.sentiment === 'negative') return 'escalate';
  if (state.sentiment === 'positive') return 'respond';
  return END; // neutral — stop
});
```

Nodes without any outbound edge implicitly go to `END`.

### CallbackGraphNode

Wraps a plain function as a graph node. Ideal for lightweight logic, transforms, and adapter code.

```ts
import { CallbackGraphNode } from '@nucleic/agentic';

const increment = new CallbackGraphNode<MyState>('inc', async (state) => {
  state.counter++;
});
```

### LlmGraphNode

Calls an `ILLMProvider` and writes the result to a designated state field. Decoupled from prompt construction — you supply a `prompt` function that reads whatever it needs from state.

```ts
import { LlmGraphNode } from '@nucleic/agentic';

const research = new LlmGraphNode<ResearchState>({
  id: 'research',
  provider: myLlm,
  prompt: (state) => ({
    instructions: 'Research the given topic thoroughly.',
    text: state.topic,
  }),
  outputKey: 'sources',
  model: 'gpt-4',        // optional override
  temperature: 0.3,      // optional override
  schema: { /* JSON Schema for structured output */ }, // optional
});
```

### SubGraphNode

Wraps a complete graph engine as a single node in a parent graph. State mapping functions translate between parent and sub-graph state, keeping the sub-graph fully isolated.

```ts
import { SubGraphNode } from '@nucleic/agentic';

// Build a sub-graph engine separately
const detailEngine = new StateGraphBuilder<DetailState>()
  .addNode(fetchNode)
  .addNode(parseNode)
  .setEntry('fetch')
  .addEdge('fetch', 'parse')
  .build();

// Wrap it as a parent-graph node
const detailNode = new SubGraphNode<ArticleState, DetailState>({
  id: 'detail-research',
  engine: detailEngine,
  input:  (parent) => ({ query: parent.topic, result: '' }),
  output: (sub, parent) => { parent.details = sub.result; },
});

// Use in parent graph
const parentEngine = new StateGraphBuilder<ArticleState>()
  .addNode(planNode)
  .addNode(detailNode)
  .setEntry('plan')
  .addEdge('plan', 'detail-research')
  .build();
```

After execution, `detailNode.lastRunResult` exposes the sub-graph's snapshots and step count for inspection.

### LLM Agent Loop Example

A full plan → research → review loop combining `LlmGraphNode` and conditional routing:

```ts
interface AgentState extends GraphState {
  goal: string;
  plan: string;
  research: string;
  answer: string;
  approved: boolean;
  iteration: number;
}

const planNode = new LlmGraphNode<AgentState>({
  id: 'plan',
  provider: llm,
  prompt: (s) => ({
    instructions: 'Create a research plan for the goal.',
    text: s.goal,
  }),
  outputKey: 'plan',
});

const researchNode = new LlmGraphNode<AgentState>({
  id: 'research',
  provider: llm,
  prompt: (s) => ({
    instructions: 'Research according to the plan.',
    text: s.plan,
  }),
  outputKey: 'research',
});

const reviewNode = new CallbackGraphNode<AgentState>('review', async (state) => {
  // Could use an LLM to evaluate quality
  state.iteration++;
  state.approved = state.iteration >= 2;
});

const answerNode = new LlmGraphNode<AgentState>({
  id: 'answer',
  provider: llm,
  prompt: (s) => ({
    instructions: 'Synthesize a final answer from the research.',
    text: s.research,
  }),
  outputKey: 'answer',
});

const engine = new StateGraphBuilder<AgentState>()
  .addNode(planNode)
  .addNode(researchNode)
  .addNode(reviewNode)
  .addNode(answerNode)
  .setEntry('plan')
  .addEdge('plan', 'research')
  .addEdge('research', 'review')
  .addConditionalEdge('review', (s) => s.approved ? 'answer' : 'plan')
  .build({ maxSteps: 20 });

const result = await engine.run({
  goal: 'Explain quantum entanglement',
  plan: '', research: '', answer: '',
  approved: false, iteration: 0,
});
```

### Cycle Safety & Dead Letter Queue

The engine enforces a `maxSteps` limit (default 100) to prevent infinite loops. If a node throws, the error is captured in the **dead letter queue** (DLQ) with the pre-execution state snapshot, then re-thrown.

```ts
const engine = builder.build({ maxSteps: 50 });

try {
  await engine.run(initialState);
} catch (err) {
  // Inspect what went wrong
  for (const letter of engine.deadLetterQueue) {
    console.log(letter.nodeId);    // which node failed
    console.log(letter.error);     // the Error object
    console.log(letter.state);     // state snapshot before the failure
    console.log(letter.timestamp); // when it happened
  }
}
```

### Snapshots & Replay

Every node execution produces a snapshot — a deep clone of state at that point. Use snapshots for debugging, time-travel, or audit trails.

```ts
const result = await engine.run(initialState);

for (const snap of result.snapshots) {
  console.log(`After ${snap.nodeId}:`, snap.state, `at ${snap.timestamp}`);
}
```

### Graph Validation

`StateGraphBuilder.build()` validates the graph before returning an engine. Validation checks:

| Check | Description |
|-------|-------------|
| Entry node | Must be set and must reference an existing node |
| Edge targets | Static edges must point to existing nodes (or `END`) |
| Reachability | All nodes must be reachable from the entry via BFS |

Validation errors are collected and thrown together:

```ts
try {
  builder.build();
} catch (err) {
  // "Graph validation failed:
  //   - Node 'orphan' is unreachable from entry 'start'."
}
```

### Custom Nodes

Implement `IGraphNode<TState>` to create custom node types:

```ts
import type { IGraphNode, GraphContext, GraphState } from '@nucleic/agentic';

class MyCustomNode<TState extends GraphState> implements IGraphNode<TState> {
  readonly id: string;

  constructor(id: string) {
    this.id = id;
  }

  async process(state: TState, context: GraphContext<TState>): Promise<void> {
    // Read/write state freely
    // context.nodeId, context.stepCount, context.tracer are available
  }
}
```

## Pack System

Capability packs declare what they provide and require via manifests. The registry validates dependency graphs and resolves topological boot order.

```ts
import { CapabilityRegistry } from '@nucleic/agentic';
import type { IPackManifest } from '@nucleic/agentic';

const registry = new CapabilityRegistry();

const dbPack: IPackManifest = {
  id: 'db-pack',
  version: '1.0.0',
  provides: ['IDatabase'],
  requires: [],
  migrations: [
    { id: 'create-tables', up: async (db) => { /* ... */ } },
  ],
};

const appPack: IPackManifest = {
  id: 'app-pack',
  version: '1.0.0',
  provides: ['IAppService'],
  requires: ['IDatabase'],   // depends on db-pack
  migrations: [],
};

registry.registerManifest(dbPack);
registry.registerManifest(appPack);

// Validate — returns [] if all deps met, errors otherwise
const errors = registry.validateDependencies(['db-pack', 'app-pack']);

// Resolve boot order — dependencies first
const bootOrder = registry.resolveBootOrder(['db-pack', 'app-pack']);
// → [dbPack, appPack]
```

### Pack Bootstrap

Packs can implement `IPackBootstrap` to hook into the startup lifecycle:

```ts
import type { IPackBootstrap, PackBootstrapContext } from '@nucleic/agentic';

const bootstrap: IPackBootstrap = {
  register(container, ctx) {
    // register services
  },
  async boot(container, ctx) {
    // async initialization after all packs registered
  },
};
```

## Migration Orchestrator

Runs pack migrations in dependency order, tracking which have been applied.

```ts
import {
  MigrationOrchestrator,
  InMemoryMigrationState,
} from '@nucleic/agentic';

const state = new InMemoryMigrationState(); // or implement MigrationState for persistence
const orchestrator = new MigrationOrchestrator(state, myDatabase);

const applied = await orchestrator.migrate(bootOrder);
// → ['db-pack::create-tables']
```

## Tracer

Lightweight structured event tracing with a ring buffer.

```ts
import { InMemoryTracer } from '@nucleic/agentic';

const tracer = new InMemoryTracer(5000); // max 5000 events

tracer.trace({
  simulationId: 'sim-1',
  type: 'llm-call',
  tick: 3,
  timestamp: Date.now(),
  data: { model: 'gpt-4', tokens: 1500 },
});

const recent = tracer.recent('sim-1', 10); // 10 most recent, newest first
```

## Utilities

```ts
import { estimateTokens } from '@nucleic/agentic';

estimateTokens('hello world'); // → 3  (~4 chars per token)
```

## Extending with Generics

All core interfaces use TypeScript generics with sensible defaults. This means you can use them as-is for simple cases, or bind them to domain-specific types for full type safety.

```ts
import type { TickContext, ITickStep, ITickPipeline } from '@nucleic/agentic';
import { TickPipeline } from '@nucleic/agentic';

// Your domain extends the base context
interface MyContext extends TickContext {
  temperature: number;
  humidity: number;
}

// Steps are fully typed to your context
const sensorStep: ITickStep<MyContext> = {
  id: 'read-sensors',
  order: 10,
  async execute(ctx) {
    console.log(ctx.temperature); // ✓ typed, no cast needed
  },
};

// Pipeline bound to your context
const pipeline: ITickPipeline<MyContext> = new TickPipeline<MyContext>();
pipeline.registerStep(sensorStep);
```

The same pattern applies to `IPromptContributor<MyContext>` and `IPromptContributorRegistry<MyContext>`.

## Architecture

```
agentic/
├── contracts/           # Pure interfaces — no runtime code
│   ├── graph/
│   │   └── IGraphEngine.ts  # State graph contracts (IGraph, IGraphEngine, IGraphBuilder)
│   ├── IAIBuilder.ts        # IAIPromptBuilder, IAIPromptService, IAIPipeline
│   ├── ICapabilityRegistry.ts
│   ├── ILLMProvider.ts      # ILLMProvider, LLMRequest
│   ├── IObservability.ts    # TraceEvent, ITracer
│   ├── IPackBootstrap.ts
│   ├── IPackManifest.ts
│   ├── IPromptEngine.ts     # PromptSection, IPromptEngine, IPromptContributor
│   ├── ITickPipeline.ts     # TickContext, ITickStep, ITickPipeline
│   └── index.ts             # barrel
├── runtime/             # In-memory implementations
│   ├── graph/
│   │   ├── nodes/
│   │   │   ├── CallbackGraphNode.ts
│   │   │   ├── LlmGraphNode.ts
│   │   │   └── SubGraphNode.ts
│   │   ├── StateGraph.ts         # Graph topology (nodes + edges)
│   │   ├── StateGraphBuilder.ts  # Fluent builder with validation
│   │   └── StateGraphEngine.ts   # Shared-state execution engine
│   ├── AIPipeline.ts
│   ├── AIPromptService.ts
│   ├── CapabilityRegistry.ts
│   ├── InMemoryTracer.ts
│   ├── MigrationOrchestrator.ts
│   ├── PromptContributorRegistry.ts
│   ├── PromptEngine.ts
│   ├── TickPipeline.ts
│   └── index.ts             # barrel
├── utils.ts             # estimateTokens, helpers
└── index.ts             # top-level barrel
```

**Contracts** are pure TypeScript interfaces with no runtime behavior. Import only what you need — tree-shaking friendly.

**Runtimes** are lightweight in-memory implementations. Swap them for persistent/distributed versions by implementing the same interfaces.

## Dependencies

| Dependency | Used by | Why |
|------------|---------|-----|
| `zod` | `IAIPipeline.validate()` | Schema validation in pipeline chains |

That's it. Everything else uses Node.js built-ins.

## License

MIT
