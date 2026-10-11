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
import { AgentContextAssembler } from '@nucleic-se/agentic/kernel'
```

**`AgentContextAssembler`** — grouped, two-pass conversation assembler. It treats an assistant message plus its immediately following matching `tool_result` messages as an atomic group, tries compression before dropping, preserves sticky user messages, and protects the most recent groups from trimming.

```ts
const assembler = new AgentContextAssembler({
    systemPrompt: 'You are a coding agent.',
    tokenBudget: 100_000,
    minRecentGroups: 2,  // always protect the most recent groups
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

Default behavior:

1. Build atomic groups from the conversation
2. Score older groups lower than recent groups
3. Try tool-aware compression on low-priority groups first
4. Drop whole groups only if still over budget
5. Never drop messages with `sticky === true`

The budget is a hard ceiling. If the system prompt, sticky groups, and protected
recent groups cannot fit, `assemble()` throws `ContextBudgetExceededError`
instead of returning an oversized request. Callers should treat that as a
configuration or compaction failure and must not call the provider with the
rejected context.

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
## Stable and transient sections

Builders accept a provider-neutral `stability` hint on `context` and
`contextGroup`: `stable`, `retained` (the default), or `transient`.

```ts
const prepared = await prompts.use()
  .context('Follow the task instructions and report evidence.', {
    id: 'instructions', stability: 'stable', protected: true,
  })
  .context('Relevant facts selected for this turn.', {
    id: 'evidence', stability: 'retained', priority: 20,
  })
  .context('Remaining task calls: 8', {
    id: 'resources', stability: 'transient', protected: true,
  })
  .user('Continue the task.')
  .prepare();
```

Selection still uses priority and protection. Stability neither protects content
nor freezes it across turns. Rendering groups selected sections by stability,
then phase. Stable sections use ID ordering within a phase so changing scores
cannot shuffle them; other sections retain score ordering. Existing unannotated
sections keep their previous ordering. Base `.system()` text still precedes all
sections and is conservatively reported as retained; use an explicit stable
section when its lifetime is known. Conversation messages keep their original
order and are not rearranged by these hints. Transient system sections are still
part of the system string, not automatically moved after conversation history.

`prepared.report.systemSections` contains each selected nonempty section's ID,
stability, and half-open UTF-16 `start`/`end` offsets into
`prepared.request.system`. Base system text has no section ID. Separators are
excluded; ranges are rebuilt after selection and compression. Atomic context
groups expose one range. The same report is available from the conversation
assembler and default budgeted harness context, so snapshots can inspect it.

These are composition boundaries, not cache keys or cache-hit guarantees.
Existing providers receive ordinary strings and messages. Future adapter code
can consume the prepared report to choose supported cache controls; no OpenAI,
Anthropic, or other vendor's wire fields belong in this builder metadata.

## Long-lived harness sessions

`budgetedContext` selects messages; it does not generate summaries. Compose
`agentContext` to add journaled checkpoint maintenance through the same model
execution boundary. With checkpointing enabled, the shared default summarizes older
unpinned human inputs while retaining the latest input and pinned material verbatim.
This policy is shared by the local and durable agent compositions. For example:

```ts
import { agentContext } from '@nucleic-se/agentic/harness';

const context = agentContext(systemPrompt, contextTokenBudget, {
    protectUserMessages: 'latest',
    checkpointMaxTokens: summaryOutputBudget,
});
```

The explicit `latest` option above is also the default. Set `protectUserMessages:
'all'` when every human input must remain verbatim; this can exhaust a finite context
window as a conversation grows. Disabling checkpointing defaults to `all`, so removing
summaries does not silently discard older requirements. The lower-level
`budgetedContext` also retains its conservative `all` default.

In `latest` mode the latest human input and all pinned inputs stay verbatim.
Older inputs become source evidence for the checkpoint; summaries must carry
forward still-relevant requirements and corrections. Original messages remain
in the session, while the derived checkpoint and exact model requests are
journaled separately. This is lossy working memory, not a guarantee of semantic
retention. A current input, pinned material or tool manifest that cannot fit still
fails explicitly; increasing session length must not imply increasing provider
capacity.

Maintenance never streams its internal text as the assistant's answer. Invalid
or truncated summaries get one retry using their original source range; a complete
summary that cannot fit the task context gets one shortening attempt. Receipts
retain partial outcomes and usage. Explicit `client.maintain` also uses the context
lifecycle before its final replacement, so it can operate on oversized history.
Its final summary must be complete before the replacement is committed.

Input deduplication is a separate host responsibility. Repeatedly appending the
same external history window wastes context even when checkpointing works.


### Provider overflow recovery

The local session driver recognizes `LLMContextOverflowError`, an explicit provider
rejection rather than a transport failure or truncated answer. With the default
checkpoint lifecycle it records the failed request, persists a forced-checkpoint
decision, summarizes an eligible source prefix, and retries the task request once.
It does not raise the configured context ceiling or weaken pinned-input retention.
No eligible prefix, a failed maintenance call, or a second overflow ends the run.
All maintenance and retry calls still pass normal execution admission and tracing.
Original messages and accepted-input receipts remain durable across restart.

The OpenAI-compatible and subscription adapters recognize the structured HTTP
`context_length_exceeded` code on 400/413 responses. Other adapters may produce
the same provider-neutral error only when they can establish an explicit context
rejection; arbitrary error text is not a retry signal. Stream-level errors without
that evidence remain ordinary failures. Custom drivers can use the optional pure
`ContextLifecycle.recoverOverflow` transition and must persist it and bound retries.
Reference context selection without checkpointing does not automatically recover.

### Inspection and effect reconciliation

`readSqliteSession(path, id)` from `@nucleic-se/agentic/harness/sqlite` reads committed
live WAL state without claiming ownership, initializing schema or opening a provider.
It returns private session data; use `inspectSessionRecovery(record)` for a bounded
operational view excluding prompts, tool arguments, output and error text. Its
lists contain at most 100 entries and include total counts.

`resolveSessionOperation(store, sessionId, operationId, resolution)` reconciles one
unknown tool effect using an exact expected revision, external evidence and a known
result. It shares the transition used by `SessionClient.resolveOperation`, updates
the existing tool result and appends an audit event atomically. It never dispatches
a tool, resumes a run, changes input receipts or grants authority. Offline hosts
must fence admission and own the store; running/waiting sessions are refused.
`TurnLimitError.maxTurns` is the typed conversational-loop exhaustion contract.
