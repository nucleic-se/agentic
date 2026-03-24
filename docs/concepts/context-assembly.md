# Context Assembly

Context assembly is how an agent decides what the model sees each turn. Two interfaces cover
different levels of this problem:

| Interface | Level | Purpose |
|---|---|---|
| `IContextAssembler` | Section | Combines prompt sections and tool results into a rendered prompt string |
| `IAgentContextAssembler` | Turn | Produces the full `{ system, messages }` pair passed to `TurnRequest` |

The higher-level interface, `IAgentContextAssembler`, is the one most agent implementations need.

---

## Why context selection matters

A naive agent passes the complete conversation history to the model on every turn. This works
until it doesn't: token budgets run out, irrelevant history dilutes focus, and the model attends
to noise instead of signal.

`IAgentContextAssembler` is the seam that makes history management real. The agent passes the
full conversation to `assemble()`; the assembler decides what subset the model actually sees.
Nothing else in the call path trims or rewrites the context — it all happens here.

---

## IAgentContextAssembler

```ts
import type {
    IAgentContextAssembler,
    AgentContextInput,
    AgentContextOutput,
} from '@nucleic-se/agentic/contracts'

interface AgentContextInput {
    userInput:   string     // current turn input — used for relevance scoring
    messages:    Message[]  // full raw conversation; assembler decides how much to include
    tokenBudget: number     // hard ceiling: system + messages combined
}

interface AgentContextOutput {
    system:   string     // → TurnRequest.system
    messages: Message[]  // → TurnRequest.messages  (NOT the full history)
}

interface IAgentContextAssembler {
    assemble(input: AgentContextInput): Promise<AgentContextOutput>
}
```

The key invariant: `output.messages` is what actually reaches the model. Older turns that don't
fit the budget, or that the assembler judges irrelevant, are not included. This is not cosmetic —
`output.messages` is passed directly to `TurnRequest.messages`, bypassing the raw conversation
array entirely.

`output.system` carries context that doesn't belong in the message thread: base instructions,
conversation summaries, retrieved facts, file footprints. Implementations typically render this
via `IPromptEngine`.

---

## Integration point

```
user input
    ↓
assembler.assemble({ userInput, messages: fullHistory, tokenBudget })
    ↓
{ system, messages }  ← what the model sees
    ↓
provider.turn({ system, messages, tools })
```

After the turn, the agent appends the full exchange to the raw conversation (the protocol
transcript). The assembler is consulted again on the next turn — it never mutates the history,
only projects it.

---

## Built-in implementations

```ts
import { PassThroughContextAssembler } from '@nucleic-se/agentic/runtime'
```

**`PassThroughContextAssembler`** — returns `messages` unchanged and a static system string.
Use this for Phase A implementations before a selection-aware assembler is needed:

```ts
const assembler = new PassThroughContextAssembler(config.systemPrompt)

// In your agent loop:
const context = await assembler.assemble({
    userInput,
    messages: this.conversation,
    tokenBudget: 100_000,
})

await provider.turn({
    system:   context.system,
    messages: context.messages,
    tools:    toolDefs,
})
```

```ts
import { AgentContextAssembler } from '@nucleic-se/agentic/runtime'
```

**`AgentContextAssembler`** — budget-aware assembler that selects the most recent messages that fit within the token budget. Tail-first: always includes the latest exchange, then walks backwards adding older turns until the budget is exhausted. Tool-result messages are kept together with their preceding assistant message to avoid orphaned results.

```ts
const assembler = new AgentContextAssembler({
    systemPrompt: 'You are a coding agent.',
    minRecentMessages: 4,  // always include at least the last 4 messages
})

const context = await assembler.assemble({
    userInput,
    messages: this.conversation,
    tokenBudget: 100_000,
})

await provider.turn({
    system:   context.system,
    messages: context.messages,  // trimmed to fit budget
    tools:    toolDefs,
})
```

---

## Writing a custom assembler

A production assembler typically:

1. Scores each message turn for relevance to `userInput`
2. Takes a high-priority tail unconditionally (recent context is almost always relevant)
3. Fills remaining budget with older turns ranked by relevance score
4. Renders summaries and retrieved facts into `system` via `IPromptEngine`

```ts
import type { IAgentContextAssembler, AgentContextInput, AgentContextOutput } from '@nucleic-se/agentic/contracts'

class SelectiveContextAssembler implements IAgentContextAssembler {
    constructor(
        private readonly promptEngine: IPromptEngine,
        private readonly memoryStore: IMemoryStore,
        private readonly tailTurns: number = 6,
    ) {}

    async assemble(input: AgentContextInput): Promise<AgentContextOutput> {
        // Always include the most recent turns
        const tail = input.messages.slice(-this.tailTurns * 2)

        // Retrieve relevant facts from memory
        const facts = await this.memoryStore.query({
            text:  input.userInput,
            limit: 5,
            types: ['fact', 'summary'],
        })

        // Render system via prompt engine
        const { text: system } = await this.promptEngine.compose([
            { tag: 'base',     text: this.basePrompt,        priority: 100, phase: 'system'  },
            { tag: 'context',  text: renderFacts(facts),     priority:  60, phase: 'memory'  },
        ], { tokenBudget: 8_000 })

        return { system, messages: tail }
    }
}
```

---

## IContextAssembler (section-level)

`IContextAssembler` operates one level lower — it combines already-selected `PromptSection`
objects and `ToolResult` values into a single rendered prompt string, with phase ordering and
trust-tier labeling for tool content.

```ts
import type { IContextAssembler, AssemblyInput } from '@nucleic-se/agentic/contracts'

interface AssemblyInput {
    contributorSections: PromptSection[]
    toolResults?:        ToolResult[]
    tokenBudget:         number
}
```

Use `IContextAssembler` when you are building a prompt from typed sections and need automatic
phase ordering and tool-result rendering. Use `IAgentContextAssembler` when you need to control
what message history the model sees.

The two are composable: a `IAgentContextAssembler` implementation can use `IContextAssembler`
internally to render its `system` string.
