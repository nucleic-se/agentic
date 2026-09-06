# LLM providers

All providers implement `ILLMProvider` from `@nucleic-se/agentic/contracts`. You can swap providers without changing your graph logic.

Agentic owns the public contracts. Backend SDK types belong inside their adapters;
context selection, budgets, persistence and execution policy belong to the runtime.

`AssistantMessage.continuation` carries optional opaque protocol annotations for
message replay, such as signed content metadata. Its encoding is versioned and
bound to the visible message and provider/API/model/deployment identity. Adapters
ignore unknown encodings or mismatched bindings. Rewriting text or tool calls
invalidates the state; adapters must not restore stale content over those edits.
Store annotations only, without duplicating visible text, arguments or history.

Context composition retains or drops continuation with its assistant message and
includes its serialized size in the token estimate. This is a conservative
heuristic, especially for encrypted annotations, not a backend tokenizer. Session
stores preserve it as ordinary JSON. A backend without a matching decoder can
still consume the visible message.

`TurnResponse.responseId` and `TurnRequest.previousResponseId` provide optional,
opaque provider continuation. The generic OpenAI-compatible adapter forwards
the `previous_response_id` extension only when constructed with
`previousResponseContinuation: true`; it is fail-closed by default because not
every compatible endpoint implements that extension. The application remains
responsible for scoping, persisting, expiring, and invalidating response IDs.

---

## ILLMProvider interface

```ts
interface ILLMProvider {
  /** Single call, returns structured JSON. No tool loop. */
  structured<T>(request: StructuredRequest, options?: ProviderCallOptions): Promise<StructuredResponse<T>>;

  /** Agentic turn — may return text, tool calls, or both. Caller runs the loop. */
  turn(request: TurnRequest, options?: ProviderCallOptions): Promise<TurnResponse>;

  /** Optional streaming variant of turn(). */
  streamTurn?(request: TurnRequest, onDelta: (text: string) => void, options?: ProviderCallOptions): Promise<TurnResponse>;

  /** Embed strings into vectors. */
  embed(texts: string[], options?: ProviderCallOptions): Promise<number[][]>;
}

interface ProviderCallOptions {
  signal?: AbortSignal;
  deadline?: number; // absolute Unix timestamp in milliseconds
}
```

- **`structured()`** — use for planning, classification, and evaluation where you need reliable JSON output.
- **`turn()`** — use inside a tool loop. The caller inspects `stopReason` and re-calls with tool results until `'end_turn'`.

`LlmGraphNode` does not run a tool loop. For agentic turn handling, use `AgentLlmNode` or build the loop in your own driver.

---

## AnthropicProvider

```ts
import { AnthropicProvider } from '@nucleic-se/agentic/providers';

const llm = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-sonnet-4-6',

  // Optional
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
  baseUrl: 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o',
});

// Azure OpenAI
const llm = new OpenAICompatibleProvider({
  baseUrl: 'https://my-resource.openai.azure.com/openai/deployments/my-deployment',
  apiKey: process.env.AZURE_OPENAI_KEY!,
  model: 'gpt-4o',
});

// Local vLLM / LM Studio
const llm = new OpenAICompatibleProvider({
  baseUrl: 'http://localhost:8000/v1',
  apiKey: 'not-used',
  model: 'meta-llama/Llama-3.1-8B-Instruct',
});
```

Heuristic recovery of tool calls from ordinary response text is disabled by
default. Incompatible models can opt in with `recoverTextToolCalls: true`; do
not enable it for models that support structured tool calling correctly.

---

## SubscriptionProvider

Optional subscription-auth backend implementing Agentic's `ILLMProvider`. Install
`@earendil-works/pi-ai@0.85.1` and use Node >=22.19 for this backend; core usage does
not require that dependency. Authentication is loaded through `@openai-oauth/local`.

```ts
import { SubscriptionProvider } from '@nucleic-se/agentic/providers/subscription';

const llm = new SubscriptionProvider({
  model: 'gpt-5.6-terra',
  reasoningEffort: 'low',
  onRequest: request => { /* Inspect exact decoded outgoing JSON. */ },
});
```

Authentication defaults to `CODEX_HOME/auth.json`, otherwise `~/.codex/auth.json`.
`authFilePath` selects another file; `credentials` can supply an authorized token
and receives the caller's cancellation signal. No agent runtime or CLI is invoked.

`capabilities` describes effective HTTP streaming, tool batching, zero automatic
request retries, and advisory output limits. `maxTokens` reserves context space;
the subscription endpoint does not enforce an output cap. Unknown provider
capabilities must never be interpreted as guarantees.

The adapter preserves usage, including cached input and reasoning tokens without
double-counting. It stores protocol annotations with assistant messages for replay
across restarts. Supply the complete selected message history; response-ID-only
continuation, stop sequences, and embeddings are unsupported.

The backend can normalize imperfect tool JSON. Agentic validates the resulting
arguments and applies authorization before dispatch; normalization grants no
permissions. Structured output uses one forced schema tool and rejects truncated
or ambiguous results. Schema validation remains the caller's responsibility.

`onRequest` observes decoded JSON after backend normalization, without auth
headers. It does not modify the transmitted request. Observations can contain
private task content; applications own storage and retention.

Both maintained harnesses journal these observations as `model.request` events,
correlated with the operation's intent and receipt. They describe the decoded
request before HTTP dispatch; only a receipt establishes the response. A failed
request-journal write prevents HTTP dispatch. The same observation hook is
available through per-call `ProviderCallOptions`.

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
  async structured<T>(req: StructuredRequest, options?: ProviderCallOptions): Promise<StructuredResponse<T>> {
    const raw = await callMyApi(req.messages, req.schema, { signal: options?.signal });
    return { value: raw as T, usage: { inputTokens: 0, outputTokens: 0 } };
  }

  async turn(req: TurnRequest, options?: ProviderCallOptions): Promise<TurnResponse> {
    const raw = await callMyApi(req.messages, req.tools, { signal: options?.signal });
    return {
      message: {
        role: 'assistant',
        content: raw.text,
        toolCalls: raw.tool_calls ?? [],
      },
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
  | { role: 'user';        content: string; sticky?: boolean }
  | { role: 'assistant';   content: string; toolCalls?: ToolCall[] }
  | { role: 'tool_result'; toolCallId: string; toolName?: string; content: string; isError?: boolean };
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

## Stream integrity

Streaming adapters reject premature EOF, malformed JSON events, and provider
error events instead of returning partial output as a successful turn. Token-limit
stops take precedence over tool calls; incomplete tool arguments are not executed.
SSE readers are released and cancelled on parser or consumer failure. The decoder
limits each event to 1 MiB of text and each response stream to 16 MiB of wire bytes.
Codex duplicate function-call IDs and unsupported incomplete terminal states are
protocol errors.

## Cache routing scope

`TurnRequest` and `StructuredRequest` accept an optional `cacheScope`: an opaque, stable caller-owned string. A provider may ignore it. It is a routing hint, not conversation history, a cache-hit guarantee or a security boundary. Keep it stable for a session or task; do not put changing budgets or timestamps in it.

The local session driver supplies a composition/session scope unless the request explicitly supplies one. It remains stable across reopen and differs for forks. The scope is part of the journaled model request. Shared provider instances do not own mutable session routing state.

The subscription adapter hashes the scope into a bounded key and maps it to `prompt_cache_key`, `session-id` and `x-client-request-id`. Requests without a scope retain their previous wire behavior. Other adapters can map the same neutral hint according to their provider's capabilities. No vendor-specific cache controls are required in builders or context selection.

Stable routing does not make changing input cacheable. Section stability describes layout; it does not promise provider cache reuse. Prepared request snapshots describe the host boundary; transport normalization can change the outgoing body.
