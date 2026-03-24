# Building a custom agent

This guide walks through building a complete coding agent from scratch using `@nucleic-se/agentic` primitives. The agent writes code, runs tests, and iterates until tests pass or a limit is reached.

---

## What we're building

```
write code → run tests → check result
                ↑              |
                |____ fail ____| (up to 3 times)
                                ↓
                             success / END
```

---

## 1. Define state

Every field your nodes read or write lives here:

```ts
type CodingState = {
  task: string;           // Input: what to implement
  code: string;           // Current implementation
  testOutput: string;     // Last test run output
  attempts: number;       // How many times we've tried
  passed: boolean;        // Whether tests pass
};
```

---

## 2. Set up the provider and tools

```ts
import { AnthropicProvider } from '@nucleic-se/agentic/providers';
import { CompositeToolRuntime, FsToolRuntime, ShellToolRuntime } from '@nucleic-se/agentic/tools';

const llm = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-sonnet-4-6',
});

const tools = new CompositeToolRuntime([
  new FsToolRuntime({ root: '/workspace' }),
  new ShellToolRuntime({ timeoutMs: 30_000 }),
]);
```

---

## 3. Build the nodes

### Write node (LLM)

```ts
import { LlmGraphNode } from '@nucleic-se/agentic/runtime';

const writeNode = new LlmGraphNode<CodingState>({
  id: 'write',
  provider: llm,
  prompt: (state) => ({
    instructions: state.attempts === 0
      ? 'Write TypeScript code that solves the given task. Use the fs_write tool to save your implementation to /workspace/solution.ts.'
      : `The previous attempt failed. Fix the code.\n\nTest output:\n${state.testOutput}\n\nUse fs_write to save the updated file.`,
    text: state.task,
  }),
  outputKey: 'code',    // LLM's response text is stored here
  toolRuntime: tools,   // The LLM can call fs_write and shell_exec
});
```

### Test node (callback)

```ts
import { CallbackGraphNode } from '@nucleic-se/agentic/runtime';

const testNode = new CallbackGraphNode<CodingState>('test', async (state) => {
  const result = await tools.call('shell_exec', {
    command: 'npx tsx --test /workspace/solution.test.ts',
    cwd: '/workspace',
  });
  state.testOutput = result.content;
  state.attempts += 1;
  state.passed = result.ok && result.content.includes('passed');
});
```

---

## 4. Assemble the graph

```ts
import { StateGraphBuilder, END } from '@nucleic-se/agentic/runtime';

const engine = new StateGraphBuilder<CodingState>()
  .addNode(writeNode)
  .addNode(testNode)
  .setEntry('write')
  .addEdge('write', 'test')
  .addConditionalEdge('test', (state) => {
    if (state.passed)        return END;          // Done
    if (state.attempts >= 3) return END;          // Give up
    return 'write';                               // Retry
  })
  .build({ maxSteps: 20 });
```

---

## 5. Run it

```ts
const { state, deadLetters } = await engine.run({
  task: 'Implement a function called `add(a, b)` that returns the sum of two numbers.',
  code: '',
  testOutput: '',
  attempts: 0,
  passed: false,
});

if (state.passed) {
  console.log('Tests passed after', state.attempts, 'attempt(s)');
  console.log(state.code);
} else {
  console.log('Failed after', state.attempts, 'attempts');
  console.log('Last output:', state.testOutput);
}

if (deadLetters.length) {
  console.error('Node errors:', deadLetters.map(d => `${d.nodeId}: ${d.error}`));
}
```

---

## 6. Add observability

Attach a tracer to see what's happening inside each step:

```ts
import { InMemoryTracer } from '@nucleic-se/agentic/runtime';

const tracer = new InMemoryTracer();

const engine = new StateGraphBuilder<CodingState>()
  // ... nodes and edges ...
  .build({
    maxSteps: 20,
    tracer,
    correlationId: 'coding-session-1',
    onAfterNode: (nodeId, state) => {
      console.log(`[${nodeId}] attempts=${state.attempts} passed=${state.passed}`);
    },
  });

// After the run, inspect trace events
const events = tracer.recent('coding-session-1', 50);
console.log(events);
```

---

## 7. Add budget limits

Prevent runaway costs with `GraphRunLimits`:

```ts
.build({
  maxSteps: 20,
  limits: {
    maxTotalTokens: 50_000,    // Stop if LLM usage exceeds this
    maxToolCalls: 30,           // Stop if tool calls exceed this
    maxDurationMs: 120_000,     // Stop after 2 minutes
  },
})
```

---

## Putting it all together

```ts
import { StateGraphBuilder, LlmGraphNode, CallbackGraphNode, END } from '@nucleic-se/agentic/runtime';
import { AnthropicProvider } from '@nucleic-se/agentic/providers';
import { CompositeToolRuntime, FsToolRuntime, ShellToolRuntime } from '@nucleic-se/agentic/tools';
import { InMemoryTracer } from '@nucleic-se/agentic/runtime';

type CodingState = {
  task: string;
  code: string;
  testOutput: string;
  attempts: number;
  passed: boolean;
};

async function runCodingAgent(task: string) {
  const llm = new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-sonnet-4-6',
  });

  const tools = new CompositeToolRuntime([
    new FsToolRuntime({ root: '/workspace' }),
    new ShellToolRuntime({ timeoutMs: 30_000 }),
  ]);

  const tracer = new InMemoryTracer();

  const engine = new StateGraphBuilder<CodingState>()
    .addNode(new LlmGraphNode<CodingState>({
      id: 'write',
      provider: llm,
      toolRuntime: tools,
      prompt: (state) => ({
        instructions: state.attempts === 0
          ? 'Write TypeScript code to solve the task. Save to /workspace/solution.ts using fs_write.'
          : `Fix the failing tests.\n\nOutput:\n${state.testOutput}`,
        text: state.task,
      }),
      outputKey: 'code',
    }))
    .addNode(new CallbackGraphNode<CodingState>('test', async (state) => {
      const result = await tools.call('shell_exec', {
        command: 'npx tsx --test /workspace/solution.test.ts',
        cwd: '/workspace',
      });
      state.testOutput = result.content;
      state.attempts += 1;
      state.passed = result.ok && result.content.includes('passed');
    }))
    .setEntry('write')
    .addEdge('write', 'test')
    .addConditionalEdge('test', (state) => {
      if (state.passed || state.attempts >= 3) return END;
      return 'write';
    })
    .build({ maxSteps: 20, tracer, limits: { maxTotalTokens: 50_000 } });

  return engine.run({ task, code: '', testOutput: '', attempts: 0, passed: false });
}
```

---

## What to explore next

- [State graphs](../concepts/graphs.md) — parallel edges, sub-graphs, checkpoints
- [Pre-built patterns](./patterns.md) — ReAct, RAG, Supervisor and more
- [Memory](../concepts/memory.md) — persist agent knowledge across steps
- [Prompt engine](../concepts/prompts.md) — fine-grained control over prompt composition
