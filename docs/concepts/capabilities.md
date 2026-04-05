# Capabilities

A capability is a self-contained behaviour bundle that you attach to an `AgentLlmNode`. It can contribute to three things simultaneously:

| Field | What it does |
|---|---|
| `prompt` | Injects sections into the system prompt each turn |
| `runtime` | Contributes tools the LLM can call |
| `lifecycle` | Runs code before/after turns and before/after the whole run |

The `ICapability` interface keeps these orthogonal. You implement whichever fields make sense for the behaviour — omit the rest.

---

## ICapability contract

```ts
interface ICapability<TState extends GraphState = GraphState> {
  readonly id: string;                       // Unique identifier
  readonly after?: readonly string[];        // Ordering hint (Wave 3 registry)
  active?(state: Readonly<TState>): boolean; // Gate — false = fully inactive
  readonly prompt?: IPromptContributor;      // Per-turn prompt injection
  readonly runtime?: IToolRuntime;           // Tool contribution
  readonly lifecycle?: ICapabilityLifecycle<TState>;
}
```

If `active()` is absent the capability is always active. When it returns `false`, none of the three fields are exercised — no prompt contribution, no tools, no lifecycle hooks.

---

## Lifecycle hooks

```ts
interface ICapabilityLifecycle<TState> {
  // Called once before the graph run starts.
  // Use to load context, run planning calls, initialise state.
  beforeRun?(state: TState): Promise<void>;

  // Called after each completed LLM turn.
  // Use to inject budget hints, per-turn bookkeeping.
  afterTurn?(state: TState, turn: TurnRecord): Promise<void>;

  // Called once after the run completes (normal end or stopped by limits).
  // Use to persist results, flush caches.
  afterRun?(state: TState): Promise<void>;
}
```

`afterTurn` fires for every LLM turn, not at checkpoint boundaries. Checkpoint boundaries are a Scheduler-level concept fired separately by the host runtime.

---

## Prompt contribution

`IPromptContributor.contribute()` is called by `AgentLlmNode` at every turn, after the base system prompt is read from state. The sections it returns are appended to the system prompt in the order they are returned.

```ts
interface IPromptContributor {
  id: string;
  contribute(context: PromptContributionContext): PromptSection[] | Promise<PromptSection[]>;
}
```

The `context` object passed by `AgentLlmNode` is `{ state }` — the full current graph state. Read anything you need from it.

`PromptSection` fields that matter most:

| Field | Type | Purpose |
|---|---|---|
| `id` | `string` | Unique section identifier |
| `priority` | `number` | Higher = kept when budget is tight |
| `weight` | `number` | Multiplier for priority scoring |
| `estimatedTokens` | `number` | Rough token count for budget math |
| `text` | `() => string` | Renders the section |
| `sticky` | `boolean` | If true, never dropped by budget trimming |
| `phase` | `PromptSectionPhase` | Ordering group: `constraint`, `task`, `memory`, `tools`, `history`, `user` |
| `tags` | `string[]` | Metadata for filtering/logging |

Use `sticky: true` for content that must always appear (instructions, memory, hard constraints). Use `phase: 'memory'` for retrieved context, `phase: 'constraint'` for system rules.

---

## Tool contribution

If your capability provides tools, implement `IToolRuntime` on `runtime`:

```ts
import { ToolRuntimeAdapter } from '@nucleic-se/agentic/tools';
import type { ITool } from '@nucleic-se/agentic/contracts';

const myTool: ITool = {
  name: 'my_tool',
  description: 'Does something useful',
  parameters: z.object({ input: z.string() }),
  async execute({ input }) {
    return { ok: true, content: `Result: ${input}` };
  },
};

class MyCapability implements ICapability<MyState> {
  readonly id = 'my-capability';
  readonly runtime = new ToolRuntimeAdapter([myTool]);
  // ...
}
```

`AgentLlmNode` merges `runtime.tools()` with the node's own static tool list before building the `TurnRequest`. Active capability tools are added; inactive capability tools are skipped.

---

## Wiring into AgentLlmNode

Pass capabilities in the node config:

```ts
import { AgentLlmNode } from '@nucleic-se/agentic/runtime';

const llmNode = new AgentLlmNode<MyState>({
  id: 'agent',
  provider: llm,
  systemPromptKey: 'systemPrompt',
  messagesKey: 'messages',
  outputKey: 'lastMessage',
  tools: staticToolDefs,
  capabilities: [
    new PlanningCapability({ ... }),
    new MemoryCapability({ ... }),
    new BudgetHintCapability({ ... }),
  ],
});
```

Per turn, `AgentLlmNode` does this:

1. Reads `state[systemPromptKey]` as the base system prompt.
2. For each active capability: collects `runtime.tools()` and calls `prompt.contribute({ state })`, appending sections to the base prompt.
3. Merges capability tools with the node's static tools into the final `TurnRequest`.
4. Calls the LLM.
5. After a successful turn, calls `lifecycle.afterTurn()` for each active capability.

`beforeRun` and `afterRun` are not called by `AgentLlmNode` itself — they are called by your graph's setup/teardown nodes (typically `CallbackGraphNode` entries and exits, or the host scheduler).

---

## Built-in capabilities

All available from `@nucleic-se/agentic/runtime`:

### `PlanningCapability`

Runs a structured LLM call before the main run to produce a typed plan. Seeds the plan into state before the agent loop starts.

```ts
import { PlanningCapability } from '@nucleic-se/agentic/runtime';
```

Implements `beforeRun` (calls `provider.structured()` to fill `state.plan`) and `prompt` (injects the plan as a sticky section each turn).

### `BudgetHintCapability`

Watches remaining token budget. When it drops below a threshold, injects a sticky wrap-up hint so the model knows to conclude.

```ts
import { BudgetHintCapability } from '@nucleic-se/agentic/runtime';
```

Implements `afterTurn` (checks budget, updates a hint state field) and `prompt` (emits the wrap-up hint section when active).

### `EmptyResponseCapability`

Detects repeated empty model responses and injects a recovery nudge. Can set a done flag after a configurable number of consecutive empties.

```ts
import { EmptyResponseCapability } from '@nucleic-se/agentic/runtime';
```

---

## Custom capability: project memory

Here is the full pattern used by the nucleic-echo showcase app. It demonstrates all three fields working together.

**What it does**:
- `lifecycle.beforeRun`: reads `memory.md` from the project directory into a dedicated state slot.
- `prompt`: emits that memory as a sticky section every LLM turn, regardless of what graph nodes do to `systemPrompt`.
- `lifecycle.afterRun`: appends a dated outcome entry to `memory.md` so future runs accumulate context.

```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  ICapability, ICapabilityLifecycle,
  IPromptContributor, PromptSection,
} from '@nucleic-se/agentic/contracts';

// Extend WorkerBaseState with a dedicated memory slot.
// Never touch systemPrompt directly — it gets overwritten by graph nodes.
interface WorkerState {
  title: string;
  resultSummary: string;
  memoryContext: string;  // populated by beforeRun
  systemPrompt: string;
  // ...other fields
}

export class MemoryCapability implements ICapability<WorkerState> {
  readonly id = 'memory';
  readonly lifecycle: ICapabilityLifecycle<WorkerState>;
  readonly prompt: IPromptContributor;

  constructor({ projectDir }: { projectDir: string }) {
    const memoryFile = path.join(projectDir, 'memory.md');

    this.lifecycle = {
      async beforeRun(state) {
        try {
          const content = (await fs.readFile(memoryFile, 'utf8')).trim();
          if (content) state.memoryContext = content;
        } catch {
          // No memory file yet — first run. Leave memoryContext empty.
        }
      },

      async afterRun(state) {
        const summary = state.resultSummary?.trim();
        if (!summary) return;
        const date = new Date().toISOString().slice(0, 10);
        const entry = `## [${date}] ${state.title}\n${summary}\n\n`;
        await fs.mkdir(projectDir, { recursive: true });
        await fs.appendFile(memoryFile, entry, 'utf8');
      },
    };

    this.prompt = {
      id: 'memory',
      contribute(context) {
        const state = context['state'] as WorkerState | undefined;
        const memoryContext = state?.memoryContext?.trim() ?? '';
        if (!memoryContext) return [];

        const text = [
          '=== PROJECT MEMORY ===',
          'Facts recorded from previous tasks on this project.',
          'Use as context; do not repeat verbatim in your output.',
          '',
          memoryContext,
          '=== END MEMORY ===',
        ].join('\n');

        return [{
          id: 'memory-context',
          priority: 80,
          weight: 1,
          estimatedTokens: Math.ceil(text.length / 4),
          text: () => text,
          tags: ['memory', 'project'],
          sticky: true,
          phase: 'memory',
        }];
      },
    };
  }
}
```

**Key design decisions**:

- `state.memoryContext` is a dedicated state field — `prompt.contribute()` reads from it rather than from `state.systemPrompt`. This is important because graph setup nodes often overwrite `systemPrompt` after `beforeRun` runs, which would silently drop any content written there.
- `sticky: true` ensures the memory section survives token budget trimming.
- `phase: 'memory'` places it in the right structural position relative to task framing and history.
- The `prompt` contributor runs at every LLM turn inside `AgentLlmNode`, making it immune to timing issues between graph nodes.

---

## Design checklist

When writing a capability:

- **Use a dedicated state field** for anything `beforeRun` produces. Don't write to `systemPrompt` directly.
- **`prompt.contribute` should be pure** — it only reads state and returns sections. Side effects belong in lifecycle hooks.
- **`sticky: true`** for anything that must survive budget trimming (memory, constraints, plan summaries).
- **`active()`** when the capability should be conditionally inactive (e.g. disabled by config flag, or after task completion).
- **`runtime`** only when your capability genuinely adds new tools. Don't wrap the node's own tools through here.
