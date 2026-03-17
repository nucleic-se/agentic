# CodingAgent

A stateful coding agent built on `@nucleic-se/agentic` primitives.

Reference implementation showing how the library's primitives compose into a
working agent runtime. Read the code, copy the patterns.

---

## Quick start

```bash
# Single-shot task
npx tsx demo/agent/cli.ts "what does this codebase do?" -C ~/my-project

# Interactive session
npx tsx demo/agent/cli.ts -i -C ~/my-project -v

# Override the chat model
npx tsx demo/agent/cli.ts -i -C . -m kimi-k2.5:cloud

# With debug log + span trace
npx tsx demo/agent/cli.ts "add tests for utils.ts" -C . -v -t -d

# Use Anthropic instead of Ollama
npx tsx demo/agent/cli.ts -i -C . -p anthropic
```

### CLI options

| Flag | Description | Default |
|------|-------------|---------|
| `-C, --cwd <path>` | Working directory for tools | `.` |
| `-p, --provider` | `ollama` or `anthropic` | `AGENT_PROVIDER` or `ollama` |
| `-m, --model` | Override balanced (chat) model | env or provider default |
| `-s, --system` | Custom system prompt | built-in |
| `--max-turns <n>` | Turn limit | `20` |
| `-i, --interactive` | Multi-turn REPL | off |
| `-v, --verbose` | Show turn metadata (timing, tokens) | off |
| `-t, --trace` | Dump hierarchical span trace | off |
| `-d, --debug-log` | Write full JSON log to `.agent-logs/` | off |
| `-a, --auto-stop` | Skip follow-up LLM call when all tools succeed | off |

### Environment variables

| Variable | Purpose |
|----------|---------|
| `AGENT_PROVIDER` | Default provider (`ollama` or `anthropic`) |
| `AGENT_FAST_MODEL` | Override fast tier model (summaries, extraction) |
| `AGENT_BALANCED_MODEL` | Override balanced tier model (main chat) |
| `AGENT_CAPABLE_MODEL` | Override capable tier model |
| `AGENTIC_OLLAMA_API_KEY` | Ollama Cloud API key |
| `AGENTIC_OLLAMA_BASE_URL` | Ollama base URL (default: Ollama Cloud) |
| `AGENTIC_ANTHROPIC_API_KEY` | Anthropic API key |
| `OLLAMA_NUM_CTX` | Override Ollama context window size |

Set these in a `.env` file in your project or in the package root.

### Interactive commands

| Command | Effect |
|---------|--------|
| `/exit`, `/quit` | End session |
| `/clear` | Reset conversation, history, summaries, facts |
| `/history` | Show turn count |

---

## Programmatic usage

```ts
import { createCodingAgent, createCodingTools } from './demo/agent/index.js'
import { OllamaProvider } from './providers/index.js'

const provider = new OllamaProvider({ model: 'glm-5:cloud' })
const router = { select: () => provider }

const agent = createCodingAgent({
  router,
  tools:        createCodingTools({ cwd: process.cwd() }),
  systemPrompt: 'You are a coding assistant.',
})

const records = await agent.prompt('What does the entry point do?', (event) => {
  if (event.type === 'message_end') process.stdout.write(event.message.content + '\n')
  if (event.type === 'tool_end')    console.log(`  ${event.name} → ${event.execution.status}`)
})

console.log(`Completed in ${records.length} turn(s)`)
```

---

## Architecture

### Three stores

Every agent run maintains three separate stores that are not projectable from
each other:

| Store | Contents | Owner |
|-------|----------|-------|
| **Conversation** | `Message[]` — the full LLM-visible dialogue | `CodingAgent` |
| **Execution** | `TurnRecord[]` — what actually happened | `CodingAgent` |
| **Context** | Assembled system prompt + selected sections | `ContextBroker` |

### Turn lifecycle

```
idle
  |  prompt() or continue()
  v
deliberating ──── LLM call fails ────> failed
  |
  v  model responds
planning ──── max_tokens ──> partial
  |
  |── end_turn ──> done (or loop via follow-up messages)
  |
  v  tool_use
executing ──── AbortSignal ──> aborted
  |              |── steering ──> reconcile early
  v
reconciling ──> idle (next turn)
```

### Turn record

Every turn produces a `TurnRecord` — the canonical debug object:

```ts
{
  turnId, userInput,
  modelRequest,    // exactly what was sent to the provider
  modelResponse,   // exactly what came back
  plan,            // all tool calls the model intended
  executions,      // what actually ran (may be partial if interrupted)
  outcome,         // 'answered' | 'partial' | 'failed' | 'aborted' | 'interrupted'
  failure?,        // set on failed/aborted/partial
  interrupted?,    // set when steering/abort broke mid-execution
  durationMs, tokenUsage, contextUsed?,
}
```

### Tools

7 tools available, scoped to `--cwd`:

| Tool | Trust Tier | Description |
|------|-----------|-------------|
| `fs_read` | trusted | Read file contents |
| `fs_write` | standard | Write/append to files |
| `fs_list` | trusted | List directory contents |
| `fs_delete` | standard | Delete files |
| `fs_move` | standard | Rename/move files |
| `shell_run` | standard | Execute shell commands (30s timeout) |
| `fetch_get/post` | untrusted | HTTP requests (16KB clip, injection detection) |

### Policy layer

Every tool call passes through `ToolPolicy.evaluate()` before execution.
Decisions: `allow` / `rewrite` (modify args) / `deny` (synthetic error) /
`confirm` (pause for user confirmation via hook).

Trust tiers are resolved from `IToolRegistry`. Untrusted tool results are
normalized into `ExternalArtifact` with content clipping and an
`containsInstructions` flag for prompt injection detection.

### Context broker

Replaces "pass all messages every turn" with scored selection + budget
enforcement:

1. **Selection** — score candidates on recency, relevance, and authority
2. **Rendering** — `IPromptEngine.compose()` enforces hard token budget
3. **Tail messages** — last N turns stay raw; older turns become summaries

Budget enforcement includes tail messages — if they exceed remaining budget,
tailTurns is dynamically reduced.

### Summaries and facts

Post-turn background tasks (fast model tier):

- **Turn summaries** — compressed representation of each turn (intent, tools
  used, key findings, unresolved items). Available for context assembly on
  subsequent prompts.
- **Fact extraction** — persistent facts extracted from tool results (file
  paths, config values, API endpoints). Stored in `FactStore` and queried by
  the context broker for relevance.

Both flush before `agent_end` — guaranteed to complete before `prompt()` returns.

### Hooks

| Hook | When | Purpose |
|------|------|---------|
| `beforeToolCall` | After policy, before execution | Skip or modify tool args |
| `afterToolCall` | After execution | Modify tool result |
| `confirmToolCall` | When policy returns `confirm` | User confirmation channel |
| `onBeforeLlmCall` | Before provider call | Transform messages |
| `getSteeringMessages` | After each tool call | Inject steering mid-turn |
| `getFollowUpMessages` | After end_turn | Inject follow-up prompts |

### Observability

Optional `ISpanTracer` produces hierarchical spans:

```
agent-run
  agent-turn
    agent-tool.fs_read    2ms   ok
    agent-tool.shell_run  150ms ok
  agent-turn
```

Use `-t` to dump spans after a CLI run. Use `-d` for full JSON debug logs
written to `.agent-logs/`.

---

## Files

```
demo/agent/
  README.md                  This file
  cli.ts                     CLI entry point — single-shot and interactive REPL
  config.ts                  AgentConfig type definition
  index.ts                   Barrel: createCodingAgent, createCodingTools, createCodingRegistry

  kernel.ts                  Core loop: deliberate / plan / execute / reconcile
  kernel.test.ts             24 behavioural tests (mock provider, no network)
  CodingAgent.ts             Stateful wrapper — owns stores, wires broker + summarization
  CodingAgent.test.ts        6 integration tests (summary flow, facts, file tracker)
  tools.ts                   Tool definitions and trust tier assignments
  artifact.ts                ExternalArtifact normalization for untrusted results
  hooks.ts                   Hook context types (beforeToolCall, afterToolCall, etc.)

  context-broker.ts          3-axis scoring + IPromptEngine budget enforcement
  turn-summarizer.ts         TurnSummary generation via fast model tier
  session-file-tracker.ts    Cumulative read/write path tracking
  fact-store.ts              Scratchpad + semantic facts backed by IMemoryStore
  fact-extractor.ts          Post-turn fact extraction via structured LLM call

  docs/
    roadmap.md               Maturity roadmap — 16 workstreams, 4 phases
    three-stores.md          Why conversation/execution/context are separate
    context-broker.md        Scoring, selection, and budget enforcement details
    failure-model.md         Every failure category with recovery policy
```

---

## Failure handling

| Failure | Continues? | TurnOutcome |
|---------|-----------|-------------|
| LLM transport/protocol error | No | `failed` |
| Policy denial | Yes — synthetic result | per-execution |
| Tool runtime error | Yes — error passed to model | per-execution |
| Tool timeout | Yes — treated as runtime failure | per-execution |
| Max turns exceeded | No | no TurnRecord (fires between turns) |
| `max_tokens` stop | No | `partial` |
| AbortSignal | No | `aborted` |
| Steering interruption | Yes — loop restarts | `interrupted` |
| Context assembly error | No | no TurnRecord (fires before turn_start) |

`agent_end` always fires in `finally`. Context errors and max-turns fire before
`turn_start` and produce no TurnRecord — only error + agent_end events.

---

## Tests

```bash
# Run all tests (249 total)
npm test

# Run only demo/agent tests
npx vitest run demo/agent/kernel.test.ts demo/agent/CodingAgent.test.ts
```

Kernel tests cover: text/tool responses, event ordering, policy decisions
(deny/confirm/rewrite), abort, max turns, autoStop, modelRequest fidelity, tool
result truncation, runtime errors, LLM errors, context errors, conversation
mutation, steering, hooks, streaming.

CodingAgent tests cover: summary flush, summaries in context across prompts,
fact extraction, file tracker, clearSession, graceful degradation on
summarization failure.
