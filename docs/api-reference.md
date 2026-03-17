# API reference

Quick reference for all exported types, classes, and functions.

---

## Entry points

| Import path | Contents |
|---|---|
| `@nucleic-se/agentic` | Everything below, re-exported |
| `@nucleic-se/agentic/contracts` | TypeScript interfaces — zero runtime code |
| `@nucleic-se/agentic/runtime` | Concrete implementations |
| `@nucleic-se/agentic/patterns` | Pre-built agent workflows |
| `@nucleic-se/agentic/tools` | Tool runtime implementations |
| `@nucleic-se/agentic/providers` | LLM provider implementations |

---

## Graph

### `StateGraphBuilder<TState>`

```ts
import { StateGraphBuilder } from '@nucleic-se/agentic/runtime';
```

| Method | Returns | Description |
|---|---|---|
| `.addNode(node)` | `this` | Register a node |
| `.setEntry(nodeId)` | `this` | Set the entry node |
| `.addEdge(from, to)` | `this` | Static edge (`to` can be `END`) |
| `.addConditionalEdge(from, router)` | `this` | Dynamic routing function |
| `.addParallelEdge(from, edge)` | `this` | Fan-out with merge |
| `.build(config?)` | `IGraphEngine<TState>` | Compile and validate the graph |

### `GraphEngineConfig`

```ts
interface GraphEngineConfig {
  maxSteps?: number;                          // Default: 100
  tracer?: ITracer;
  correlationId?: string;
  limits?: OrchestratorLimits;
  onBeforeNode?: (nodeId: string, state: unknown) => void;
  onAfterNode?: (nodeId: string, state: unknown) => void;
}
```

### `OrchestratorLimits`

```ts
interface OrchestratorLimits {
  maxTotalTokens?: number;
  maxToolCalls?: number;
  maxDurationMs?: number;
}
```

### `IGraphEngine<TState>`

```ts
interface IGraphEngine<TState> {
  run(initialState: TState): Promise<GraphRunResult<TState>>;
  step(state: TState, nodeId: string): Promise<TState>;
  checkpoint(): Promise<GraphCheckpoint<TState>>;
  resume(checkpoint: GraphCheckpoint<TState>): Promise<GraphRunResult<TState>>;
}
```

### `GraphRunResult<TState>`

```ts
interface GraphRunResult<TState> {
  state: TState;
  stepsTaken: number;
  deadLetters: GraphDeadLetter[];  // { nodeId, error, state }
}
```

### `END`

```ts
import { END } from '@nucleic-se/agentic/runtime';
// or
import { END } from '@nucleic-se/agentic/contracts';
```

Sentinel value returned from conditional edge routers to terminate execution.

---

## Nodes

### `CallbackGraphNode<TState>`

```ts
import { CallbackGraphNode } from '@nucleic-se/agentic/runtime';

new CallbackGraphNode<TState>(
  id: string,
  fn: (state: TState, ctx: GraphContext<TState>) => Promise<void>
)
```

Mutate `state` in place. No return value.

### `LlmGraphNode<TState>`

```ts
import { LlmGraphNode } from '@nucleic-se/agentic/runtime';

new LlmGraphNode<TState>(config: LlmGraphNodeConfig<TState>)
```

```ts
interface LlmGraphNodeConfig<TState> {
  id: string;
  provider: ILLMProvider;
  prompt: (state: Readonly<TState>) => {
    instructions: string;
    text: string;
    schema?: JsonSchema;   // Triggers structured() instead of turn()
  };
  outputKey: keyof TState & string;
  schema?: JsonSchema;     // Applied to all calls; prompt() schema takes precedence
  model?: string;
  temperature?: number;
  toolRuntime?: IToolRuntime;
}
```

### `SubGraphNode<TParent, TSub>`

```ts
import { SubGraphNode } from '@nucleic-se/agentic/runtime';

new SubGraphNode<TParent, TSub>(config: SubGraphNodeConfig<TParent, TSub>)
```

```ts
interface SubGraphNodeConfig<TParent, TSub> {
  id: string;
  engine: IGraphEngine<TSub> | ((parentState: TParent) => IGraphEngine<TSub>);
  input: (parent: TParent) => TSub;
  output: (sub: TSub, parent: TParent) => void;
}
```

### `GraphContext<TState>`

Passed as the second argument to `CallbackGraphNode` and `IGraphNode.process()`:

```ts
interface GraphContext<TState> {
  nodeId: string;
  stepCount: number;
  tracer: ITracer;
  correlationId: string;
  reportToolCall(count?: number): void;
  reportTokens(count: number): void;
}
```

### `NodeRetryPolicy`

Attach to any node to configure automatic retry:

```ts
interface NodeRetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  backoffMultiplier?: number;  // Default: 2.0
  retryOn?: string[];          // Error.name filter
}
```

---

## LLM providers

### `AnthropicProvider`

```ts
import { AnthropicProvider } from '@nucleic-se/agentic/providers';

new AnthropicProvider({
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  baseUrl?: string;
  minRequestSpacingMs?: number;
  onRetry?: (attempt: number, delayMs: number, status: number) => void;
})
```

### `OpenAICompatibleProvider`

```ts
import { OpenAICompatibleProvider } from '@nucleic-se/agentic/providers';

new OpenAICompatibleProvider({
  baseURL: string;
  apiKey: string;
  model: string;
})
```

### `OllamaProvider`

```ts
import { OllamaProvider } from '@nucleic-se/agentic/providers';
import { OLLAMA_LOCAL_API_BASE, OLLAMA_CLOUD_API_BASE } from '@nucleic-se/agentic/providers';

new OllamaProvider({
  model: string;
  baseUrl?: string;   // Default: OLLAMA_LOCAL_API_BASE
  apiKey?: string;
})
```

### `ILLMProvider`

```ts
interface ILLMProvider {
  structured<T>(request: StructuredRequest): Promise<StructuredResponse<T>>;
  turn(request: TurnRequest): Promise<TurnResponse>;
  embed?(texts: string[]): Promise<number[][]>;
}
```

---

## Tool runtimes

All runtimes extend `IToolRuntime`:

```ts
interface IToolRuntime {
  tools(): ToolDefinition[];
  call(name: string, args: unknown, options?: ToolCallOptions): Promise<ToolCallResult>;
}

interface ToolCallResult {
  ok: boolean;
  content: string;
  data?: unknown;
}

interface ToolCallOptions {
  signal?:    AbortSignal                        // cancellation token
  onUpdate?:  (details: unknown) => void         // streaming progress; ignored if unsupported
}
```

| Class | Import | Options |
|---|---|---|
| `CompositeToolRuntime` | `@nucleic-se/agentic/tools` | `(runtimes: IToolRuntime[])` |
| `FsToolRuntime` | `@nucleic-se/agentic/tools` | `{ root: string }` |
| `FetchToolRuntime` | `@nucleic-se/agentic/tools` | `{ timeoutMs?: number }` |
| `ShellToolRuntime` | `@nucleic-se/agentic/tools` | `{ timeoutMs?: number }` |
| `SearchToolRuntime` | `@nucleic-se/agentic/tools` | `{ root: string }` |
| `WebToolRuntime` | `@nucleic-se/agentic/tools` | `{}` |
| `SkillToolRuntime` | `@nucleic-se/agentic/tools` | `{}` |

---

## Memory

### `InMemoryStore`

```ts
import { InMemoryStore } from '@nucleic-se/agentic/runtime';
```

```ts
interface IMemoryStore {
  get(id: string): Promise<MemoryItem | undefined>;
  query(query: MemoryQuery): Promise<MemoryItem[]>;
  write(item: Omit<MemoryItem, 'id' | 'version' | 'createdAt' | 'updatedAt'>): Promise<MemoryItem>;
  update(id: string, patch: Partial<MemoryItem>): Promise<MemoryItem>;
  delete(id: string): Promise<void>;
  evictExpired(): Promise<number>;
}
```

```ts
type MemoryType = 'working' | 'episodic' | 'semantic' | 'procedural';

interface MemoryQuery {
  types?: MemoryType[];
  tags?: string[];
  keys?: string[];
  limit?: number;
  tokenBudget?: number;
  minConfidence?: number;
}
```

---

## Prompt engine

### `PromptEngine`

```ts
import { PromptEngine } from '@nucleic-se/agentic/runtime';

const engine = new PromptEngine();
const result = engine.compose(sections: PromptSection[], tokenBudget?: number): PromptComposeResult;
```

```ts
interface PromptComposeResult {
  text: string;
  included: PromptSection[];
  excluded: PromptSection[];
  totalTokens: number;
}
```

### `PromptSection`

```ts
interface PromptSection {
  id: string;
  text: () => string;
  priority: number;
  weight: number;
  estimatedTokens: number;
  sticky?: boolean;
  tags: string[];
  phase?: 'constraint' | 'task' | 'memory' | 'tools' | 'history' | 'user';
  contextMultiplier?: number;
}
```

---

## Observability

### `InMemoryTracer`

```ts
import { InMemoryTracer } from '@nucleic-se/agentic/runtime';

const tracer = new InMemoryTracer();
tracer.trace({ correlationId, type: 'event', timestamp: Date.now(), data: {} });
const events = tracer.recent(correlationId, limit);
```

### `InMemorySpanTracer`

```ts
import { InMemorySpanTracer } from '@nucleic-se/agentic/runtime';

const tracer = new InMemorySpanTracer();
const spanId = tracer.startSpan({ correlationId, type: 'node', startTime: Date.now() });
tracer.endSpan(spanId, 'ok');
const spans = tracer.spans(correlationId);
```

---

## Utilities

### `estimateTokens`

```ts
import { estimateTokens } from '@nucleic-se/agentic';

const tokens = estimateTokens(text: string): number;
// Approximation: Math.ceil(text.length / 4)
```

### `ToolRegistry`

```ts
import { ToolRegistry } from '@nucleic-se/agentic/runtime';

const registry = new ToolRegistry();
registry.register(tool: ITool<any, any>): void;
registry.resolve(name: string): ITool<any, any>;
registry.list(): ITool<any, any>[];
```

---

## Tool policy

### `PassThroughToolPolicy` / `TrustTierToolPolicy`

```ts
import { PassThroughToolPolicy, TrustTierToolPolicy } from '@nucleic-se/agentic/runtime'
```

Evaluate a planned tool call before execution — allow, rewrite args, deny, or require confirmation.

```ts
interface PolicyContext {
  callId:    string
  name:      string
  args:      Record<string, unknown>
  trustTier: ToolTrustTier   // 'trusted' | 'standard' | 'untrusted'
}

type PolicyDecision =
  | { kind: 'allow' }
  | { kind: 'rewrite'; args: Record<string, unknown>; reason: string }
  | { kind: 'deny';    reason: string }
  | { kind: 'confirm'; reason: string }

interface IToolPolicy {
  evaluate(context: PolicyContext): Promise<PolicyDecision>
}
```

**`PassThroughToolPolicy`** — allows every call unconditionally.

**`TrustTierToolPolicy`** — denies calls to tools not in `IToolRegistry`; allows all known tools.
Subclass to add tier-specific rules. See [Tool policy](./concepts/tool-policy.md) for examples.

---

## Context assembly

### `PassThroughContextAssembler`

```ts
import { PassThroughContextAssembler } from '@nucleic-se/agentic/runtime'

new PassThroughContextAssembler(systemPrompt?: string)
```

The minimal `IAgentContextAssembler`: returns messages unchanged, system as-is.

```ts
interface AgentContextInput {
  userInput:   string
  messages:    Message[]   // full raw conversation
  tokenBudget: number
}

interface AgentContextOutput {
  system:   string     // → TurnRequest.system
  messages: Message[]  // → TurnRequest.messages
}

interface IAgentContextAssembler {
  assemble(input: AgentContextInput): Promise<AgentContextOutput>
}
```

See [Context assembly](./concepts/context-assembly.md) for the selection model and custom assembler guidance.

---

## Pre-built patterns

All imported from `@nucleic-se/agentic/patterns`:

| Factory | Config | State type |
|---|---|---|
| `createReActAgent` | `ReActConfig` | `ReActState` |
| `createPlanExecuteAgent` | `PlanExecuteConfig` | `PlanExecuteState` |
| `createReflectionAgent` | `ReflectionConfig` | `ReflectionState` |
| `createRAGAgent` | `RAGConfig` | `RAGState` |
| `createChainOfThoughtAgent` | `ChainOfThoughtConfig` | `ChainOfThoughtState` |
| `createSupervisorAgent` | `SupervisorConfig` | `SupervisorState` |
| `createHumanInLoopAgent` | `HumanInLoopConfig` | `HumanInLoopState` |

All configs extend `PatternConfig<TState>`:

```ts
interface PatternConfig<TState> {
  llm: ILLMProvider;
  tracer?: ITracer;
  maxIterations?: number;
}
```

See [Patterns guide](./guides/patterns.md) for per-pattern state shapes and config fields.

---

## Contracts index

All interfaces without runtime code — safe to import in library code without pulling in dependencies:

```ts
import type {
  // Graph
  IGraphEngine, IGraphBuilder, IGraphNode, GraphContext,
  GraphState, GraphRunResult, GraphCheckpoint, GraphDeadLetter,
  RouterFn, AsyncRouterFn, ParallelEdge, ParallelMergeFn,
  GraphEngineConfig, OrchestratorLimits, NodeRetryPolicy,
  GraphEnd,

  // LLM
  ILLMProvider, IModelRouter, ModelTier,
  Message, UserMessage, AssistantMessage, ToolResultMessage,
  ToolCall, ToolDefinition, TokenUsage,
  StructuredRequest, StructuredResponse, TurnRequest, TurnResponse, StopReason,

  // Tools
  IToolRuntime, ToolCallResult, ToolCallOptions,
  ITool, ToolResult, ToolTrustTier, IToolRegistry, RetryPolicy, RateLimit,

  // Tool policy
  IToolPolicy, PolicyContext, PolicyDecision,

  // Context assembly
  IAgentContextAssembler, AgentContextInput, AgentContextOutput,
  IContextAssembler, AssemblyInput,

  // Memory
  IMemoryStore, IMemoryWriteValidator, MemoryItem, MemoryQuery, MemoryType,

  // Prompts
  IPromptEngine, PromptSection, PromptSectionPhase, PromptSectionTag,
  PromptComposeResult, IPromptContributor, IPromptContributorRegistry,

  // Observability
  ITracer, ISpanTracer, TraceEvent, TraceSpan,

  // Builders
  IAIPromptBuilder, IAIPromptService, IAIPipeline,

  // Shared
  JsonSchema,
} from '@nucleic-se/agentic/contracts';
```
