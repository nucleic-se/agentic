# Pre-built patterns

All patterns are factories that return an `IGraphEngine`. Import from `@nucleic-se/agentic/patterns`.

Every factory accepts a `PatternConfig` base:

```ts
interface PatternConfig<TState> {
  llm: ILLMProvider;      // Required
  tracer?: ITracer;
  maxIterations?: number; // Default: 10
}
```

---

## ReAct (Reason + Act)

Alternates between reasoning about the next action, executing a tool, and observing the result. Ideal for question-answering with tools.

```ts
import { createReActAgent } from '@nucleic-se/agentic/patterns';

const agent = createReActAgent({
  llm,
  tools: {
    search:    async (query) => await mySearchFn(query),
    calculate: async (expr)  => String(eval(expr)),
  },
  maxIterations: 5,
});

const { state } = await agent.run({
  goal: 'What is 15% of 240?',
  thought: '', action: '', actionInput: '',
  observation: '', answer: '', iteration: 0,
});

console.log(state.answer); // "36"
```

**State fields:**

| Field | Description |
|---|---|
| `goal` | The question or task to accomplish |
| `thought` | Current reasoning step |
| `action` | Tool name to invoke, or `'FINISH'` |
| `actionInput` | Input string for the tool |
| `observation` | Tool result |
| `answer` | Final answer (populated when `action === 'FINISH'`) |
| `iteration` | Current loop count |

**Flow:** `reason → parse → act → decide → (repeat or END)`

---

## Plan-Execute

Decomposes a problem into a step-by-step plan, executes each step, then synthesises a final result.

```ts
import { createPlanExecuteAgent } from '@nucleic-se/agentic/patterns';

const agent = createPlanExecuteAgent({
  llm,
  tools: { run_sql: async (sql) => await db.query(sql) },
  maxSteps: 20,
});

const { state } = await agent.run({
  problem: 'Migrate the users table to include a display_name column.',
});

console.log(state.result);
```

**Flow:** `plan → execute steps → verify → END`

---

## Reflection

Generates an initial attempt, reflects on it, identifies weaknesses, and refines until satisfied or `maxAttempts` is reached. Good for creative tasks or tasks requiring quality improvement.

```ts
import { createReflectionAgent } from '@nucleic-se/agentic/patterns';

const agent = createReflectionAgent({
  llm,
  maxAttempts: 3,
});

const { state } = await agent.run({
  problem: 'Write a haiku about winter.',
});

console.log(state.refined);
```

**Flow:** `generate → reflect → refine → (repeat or END)`

---

## RAG (Retrieval-Augmented Generation)

Retrieves relevant documents, builds context from them, then generates a grounded answer.

```ts
import { createRAGAgent } from '@nucleic-se/agentic/patterns';

const agent = createRAGAgent({
  llm,
  retriever: async (query) => {
    return await vectorStore.search(query, { topK: 5 });
  },
});

const { state } = await agent.run({
  query: 'What is our refund policy for digital products?',
});

console.log(state.answer);
```

**Flow:** `retrieve → augment → generate → END`

---

## Chain-of-Thought

Forces the model to reason step-by-step before giving a final answer. Improves accuracy on reasoning-heavy problems.

```ts
import { createChainOfThoughtAgent } from '@nucleic-se/agentic/patterns';

const agent = createChainOfThoughtAgent({ llm });

const { state } = await agent.run({
  problem: 'Is 17 a prime number? Show your reasoning.',
});

console.log(state.answer);
```

**Flow:** `think → answer → END`

---

## Supervisor-Worker

A supervisor delegates sub-tasks to specialised worker agents, collects their outputs, and synthesises a final result.

```ts
import { createSupervisorAgent } from '@nucleic-se/agentic/patterns';

const agent = createSupervisorAgent({
  llm,
  workers: [researchAgent, writingAgent, reviewAgent],
});

const { state } = await agent.run({
  problem: 'Write a market analysis report for the EV sector.',
});

console.log(state.result);
```

Workers are any `IGraphEngine` instances — they can be other patterns, custom graphs, or `SubGraphNode`-wrapped sub-agents.

**Flow:** `plan tasks → dispatch to workers → synthesise → END`

---

## Human-in-the-Loop

Pauses at decision points to collect human input before continuing. Use for approval workflows, ambiguous situations, or semi-autonomous agents.

```ts
import { createHumanInLoopAgent } from '@nucleic-se/agentic/patterns';
import * as readline from 'readline';

const agent = createHumanInLoopAgent({
  llm,
  humanInputFn: async (prompt) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
      rl.question(prompt + '\n> ', (answer) => { rl.close(); resolve(answer); });
    });
  },
});

const { state } = await agent.run({
  problem: 'Should we deploy the new schema migration to production?',
});
```

**Flow:** `assess → ask human → act on response → END`

---

## Composing patterns with SubGraphNode

Patterns can be nested inside a larger graph using `SubGraphNode`:

```ts
import { SubGraphNode } from '@nucleic-se/agentic/runtime';
import { createRAGAgent } from '@nucleic-se/agentic/patterns';

type OuterState = { userQuery: string; ragAnswer: string; finalReport: string };

const ragEngine = createRAGAgent({ llm, retriever });

const ragStep = new SubGraphNode<OuterState, RAGState>({
  id: 'rag-lookup',
  engine: ragEngine,
  input:  (outer) => ({ query: outer.userQuery, documents: [], answer: '' }),
  output: (sub, outer) => { outer.ragAnswer = sub.answer; },
});

const engine = new StateGraphBuilder<OuterState>()
  .addNode(ragStep)
  .addNode(reportNode)
  .setEntry('rag-lookup')
  .addEdge('rag-lookup', 'report')
  .addEdge('report', END)
  .build();
```
