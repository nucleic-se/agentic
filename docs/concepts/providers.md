# LLM providers

All providers implement `ILLMProvider` from `@nucleic-se/agentic/contracts`. You can swap providers without changing your graph logic.

---

## ILLMProvider interface

```ts
interface ILLMProvider {
  /** Single call, returns structured JSON. No tool loop. */
  structured<T>(request: StructuredRequest): Promise<StructuredResponse<T>>;

  /** Agentic turn — may return text, tool calls, or both. Caller runs the loop. */
  turn(request: TurnRequest): Promise<TurnResponse>;

  /** Embed strings into vectors. */
  embed?(texts: string[]): Promise<number[][]>;
}
```

- **`structured()`** — use for planning, classification, and evaluation where you need reliable JSON output.
- **`turn()`** — use inside a tool loop. The caller inspects `stopReason` and re-calls with tool results until `'end_turn'`.

`LlmGraphNode` handles the `turn()` loop automatically when you attach a `toolRuntime`.

---

## AnthropicProvider

```ts
import { AnthropicProvider } from '@nucleic-se/agentic/providers';

const llm = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-sonnet-4-6',

  // Optional
  temperature: 0.2,
  maxTokens: 4096,
  baseUrl: 'https://api.anthropic.com',      // Override for proxies
  minRequestSpacingMs: 1000,                 // Rate-limit guard
  onRetry: (attempt, delayMs, status) => {
    console.warn(`Retry ${attempt} after ${delayMs}ms (HTTP ${status})`);
  },
});
```

### Recommended models

| Use case | Model |
|---|---|
| Everyday tasks | `claude-haiku-4-5-20251001` (fast, cheap) |
| Balanced | `claude-sonnet-4-6` |
| Complex reasoning | `claude-opus-4-6` |

---

## OpenAICompatibleProvider

Works with OpenAI, Azure OpenAI, vLLM, LM Studio, Ollama's OpenAI endpoint, and any other OpenAI-compatible API:

```ts
import { OpenAICompatibleProvider } from '@nucleic-se/agentic/providers';

// OpenAI
const llm = new OpenAICompatibleProvider({
  baseURL: 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o',
});

// Azure OpenAI
const llm = new OpenAICompatibleProvider({
  baseURL: 'https://my-resource.openai.azure.com/openai/deployments/my-deployment',
  apiKey: process.env.AZURE_OPENAI_KEY!,
  model: 'gpt-4o',
});

// Local vLLM / LM Studio
const llm = new OpenAICompatibleProvider({
  baseURL: 'http://localhost:8000/v1',
  apiKey: 'not-used',
  model: 'meta-llama/Llama-3.1-8B-Instruct',
});
```

---

## OllamaProvider

Local inference via [Ollama](https://ollama.com). Defaults to `localhost:11434`.

```ts
import { OllamaProvider, OLLAMA_LOCAL_API_BASE } from '@nucleic-se/agentic/providers';

const llm = new OllamaProvider({ model: 'llama3.2' });

// Ollama Cloud
import { OLLAMA_CLOUD_API_BASE } from '@nucleic-se/agentic/providers';
const llm = new OllamaProvider({
  model: 'llama3.2',
  baseUrl: OLLAMA_CLOUD_API_BASE,
  apiKey: process.env.OLLAMA_API_KEY!,
});
```

---

## Implementing a custom provider

Implement `ILLMProvider` to wrap any API:

```ts
import type { ILLMProvider, StructuredRequest, StructuredResponse, TurnRequest, TurnResponse }
  from '@nucleic-se/agentic/contracts';

class MyProvider implements ILLMProvider {
  async structured<T>(req: StructuredRequest): Promise<StructuredResponse<T>> {
    const raw = await callMyApi(req.messages, req.schema);
    return { content: raw as T, usage: { inputTokens: 0, outputTokens: 0 } };
  }

  async turn(req: TurnRequest): Promise<TurnResponse> {
    const raw = await callMyApi(req.messages, req.tools);
    return {
      content: raw.text,
      toolCalls: raw.tool_calls ?? [],
      stopReason: raw.stop_reason === 'tool' ? 'tool_use' : 'end_turn',
      usage: { inputTokens: raw.usage.input, outputTokens: raw.usage.output },
    };
  }
}
```

---

## Message protocol

All providers use the same message types:

```ts
type Message =
  | { role: 'user';        content: string }
  | { role: 'assistant';   content: string; toolCalls?: ToolCall[] }
  | { role: 'tool_result'; toolCallId: string; content: string; isError: boolean };
```

---

## Token usage

Every response includes a `TokenUsage` object:

```ts
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}
```

Access it from the `turn()` / `structured()` response directly, or use the tracer for aggregate totals across a run.

---

## Stop reasons

`TurnResponse.stopReason` tells you why the model stopped:

| Value | Meaning |
|---|---|
| `'end_turn'` | Model finished naturally |
| `'tool_use'` | Model wants to call a tool — execute and re-call `turn()` |
| `'max_tokens'` | Hit token limit — consider increasing `maxTokens` |
| `'stop_sequence'` | Hit a custom stop sequence |
