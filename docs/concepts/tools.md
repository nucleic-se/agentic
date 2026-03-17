# Tool runtimes

Tools give LLM nodes the ability to act on the world — read files, call APIs, run shell commands, and more.

---

## How tools work

An `IToolRuntime` exposes a list of tool definitions and executes calls:

```ts
interface IToolRuntime {
  tools(): ToolDefinition[];                          // What the LLM can call
  call(name: string, args: unknown): Promise<ToolCallResult>;  // Execute one call
}
```

`ToolCallResult` never throws — errors are surfaced as `{ ok: false, content: '...' }` so the LLM can see them and recover:

```ts
interface ToolCallResult {
  ok: boolean;         // false on error
  content: string;     // Text shown to the LLM
  data?: unknown;      // Structured output for programmatic use
}
```

---

## Built-in runtimes

### FsToolRuntime

File system operations, scoped to a root directory.

```ts
import { FsToolRuntime } from '@nucleic-se/agentic/tools';

const fs = new FsToolRuntime({ root: '/workspace' });
```

| Tool | Args | Description |
|---|---|---|
| `fs_read` | `{ path }` | Read file contents (256 KB limit) |
| `fs_write` | `{ path, content }` | Write file (creates directories as needed) |
| `fs_delete` | `{ path }` | Delete file or directory |
| `fs_list` | `{ path?, pattern? }` | List directory contents (200 items max) |
| `fs_move` | `{ from, to }` | Move or rename a file |

All paths are relative to `root`. Paths that escape `root` are rejected.

### FetchToolRuntime

HTTP requests with retry and timeout:

```ts
import { FetchToolRuntime } from '@nucleic-se/agentic/tools';

const fetch = new FetchToolRuntime({ timeoutMs: 10_000 });
```

| Tool | Args | Description |
|---|---|---|
| `fetch_json` | `{ url, method?, headers?, body? }` | Fetch and parse JSON |
| `fetch_text` | `{ url, method?, headers?, body? }` | Fetch raw text |
| `fetch_head` | `{ url }` | Fetch headers only |

### ShellToolRuntime

Run shell commands with a timeout:

```ts
import { ShellToolRuntime } from '@nucleic-se/agentic/tools';

const shell = new ShellToolRuntime({ timeoutMs: 30_000 });
```

| Tool | Args | Description |
|---|---|---|
| `shell_exec` | `{ command, cwd? }` | Run a shell command, capture stdout/stderr |

Output is capped to prevent overwhelming the LLM context.

### SearchToolRuntime

Search files by regex or glob:

```ts
import { SearchToolRuntime } from '@nucleic-se/agentic/tools';

const search = new SearchToolRuntime({ root: process.cwd() });
```

| Tool | Args | Description |
|---|---|---|
| `search_files` | `{ pattern, glob?, maxResults? }` | Regex search across a directory tree |

### WebToolRuntime

Fetch web pages and convert to markdown:

```ts
import { WebToolRuntime } from '@nucleic-se/agentic/tools';

const web = new WebToolRuntime();
```

| Tool | Args | Description |
|---|---|---|
| `web_fetch` | `{ url }` | Fetch URL and convert HTML to markdown |
| `web_metadata` | `{ url }` | Return title, description, and open graph tags |

### SkillToolRuntime

Invoke Claude Code skills (only useful inside Claude Code environments):

```ts
import { SkillToolRuntime } from '@nucleic-se/agentic/tools';

const skills = new SkillToolRuntime();
```

---

## Combining runtimes

`CompositeToolRuntime` merges multiple runtimes into one:

```ts
import { CompositeToolRuntime, FsToolRuntime, FetchToolRuntime, ShellToolRuntime }
  from '@nucleic-se/agentic/tools';

const tools = new CompositeToolRuntime([
  new FsToolRuntime({ root: process.cwd() }),
  new FetchToolRuntime({ timeoutMs: 10_000 }),
  new ShellToolRuntime({ timeoutMs: 30_000 }),
]);
```

Attach to any `LlmGraphNode`:

```ts
new LlmGraphNode<MyState>({
  id: 'agent',
  provider: llm,
  prompt: (s) => ({ instructions: '...', text: s.task }),
  outputKey: 'result',
  toolRuntime: tools,
})
```

---

## Building a custom tool runtime

Implement `IToolRuntime` for any capability:

```ts
import type { IToolRuntime, ToolDefinition, ToolCallResult } from '@nucleic-se/agentic/contracts';

class DatabaseRuntime implements IToolRuntime {
  tools(): ToolDefinition[] {
    return [{
      name: 'db_query',
      description: 'Run a read-only SQL query.',
      inputSchema: {
        type: 'object',
        properties: { sql: { type: 'string' } },
        required: ['sql'],
      },
    }];
  }

  async call(name: string, args: unknown): Promise<ToolCallResult> {
    if (name !== 'db_query') return { ok: false, content: `Unknown tool: ${name}` };
    try {
      const { sql } = args as { sql: string };
      const rows = await db.query(sql);
      return { ok: true, content: JSON.stringify(rows, null, 2), data: rows };
    } catch (err) {
      return { ok: false, content: (err as Error).message };
    }
  }
}
```

---

## Typed tools (ITool)

For tools with validated inputs and outputs, implement `ITool<TInput, TOutput>`:

```ts
import type { ITool } from '@nucleic-se/agentic/contracts';

const myTool: ITool<{ city: string }, { temp: number }> = {
  name: 'get_weather',
  description: 'Returns current temperature for a city.',
  inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  outputSchema: { type: 'object', properties: { temp: { type: 'number' } }, required: ['temp'] },
  trustTier: 'standard',
  timeoutMs: 5000,
  async execute({ city }) {
    const data = await fetchWeather(city);
    return { temp: data.temperature };
  },
};
```

Register typed tools in a `ToolRegistry`:

```ts
import { ToolRegistry } from '@nucleic-se/agentic/runtime';

const registry = new ToolRegistry();
registry.register(myTool);

const tool = registry.resolve('get_weather');
const result = await tool.execute({ city: 'Paris' });
```

### Trust tiers

| Tier | Use |
|---|---|
| `'trusted'` | Internal tools with no sandboxing needed |
| `'standard'` | Default — normal validation and limits |
| `'untrusted'` | External or user-supplied tools — apply extra caution |
