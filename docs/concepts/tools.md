# Tools

Agentic separates three responsibilities:

1. An `ITool` describes and executes one typed operation.
2. `ToolRuntimeAdapter` validates and dispatches already-authorized calls.
3. The agent kernel evaluates policy and resolves confirmation before dispatch.

Keeping authorization out of adapters prevents a `confirm` decision from being
mistaken for permission to execute.

## Executable schemas

JSON Schema alone is provider guidance, not a runtime safety boundary. Every
typed tool therefore carries a library-neutral `RuntimeSchema<T>`:

```ts
interface RuntimeSchema<T> {
  jsonSchema: JsonSchema;
  validate(value: unknown): ValidationResult<T>;
}
```

`jsonSchema` is sent to the model. `validate` is called before execution and,
when an output schema exists, after execution. Agentic does not depend on a
schema library. Applications can implement this interface directly or adapt a
validator outside Agentic.

```ts
import type { ITool, RuntimeSchema } from '@nucleic-se/agentic/contracts';

type WeatherInput = { city: string };
type WeatherOutput = { temp: number };

const weatherInput: RuntimeSchema<WeatherInput> = {
  jsonSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  },
  validate(value) {
    if (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as Record<string, unknown>).city === 'string'
    ) {
      return { ok: true, value: value as WeatherInput };
    }
    return { ok: false, issues: [{ path: ['city'], message: 'must be a string' }] };
  },
};

const weatherOutput: RuntimeSchema<WeatherOutput> = {
  jsonSchema: {
    type: 'object',
    properties: { temp: { type: 'number' } },
    required: ['temp'],
    additionalProperties: false,
  },
  validate(value) {
    if (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as Record<string, unknown>).temp === 'number'
    ) {
      return { ok: true, value: value as WeatherOutput };
    }
    return { ok: false, issues: [{ path: ['temp'], message: 'must be a number' }] };
  },
};

const weather: ITool<WeatherInput, WeatherOutput> = {
  name: 'get_weather',
  description: 'Return the current temperature for a city.',
  input: weatherInput,
  output: weatherOutput,
  trustTier: 'standard',
  timeoutMs: 5_000,
  async execute({ city }, context) {
    const data = await fetchWeather(city, { signal: context.signal });
    return { temp: data.temperature };
  },
};
```

## Validated dispatch

Wrap typed tools in `ToolRuntimeAdapter`:

```ts
import { ToolRuntimeAdapter } from '@nucleic-se/agentic/tools';

const tools = new ToolRuntimeAdapter([weather]);
const result = await tools.call(
  'get_weather',
  { city: 'Paris' },
  { callId: 'call-1', signal: controller.signal },
);
```

The adapter:

- rejects duplicate and blank tool names at construction;
- validates input before execution;
- passes cancellation and progress reporting to the tool;
- enforces `timeoutMs` and signals the tool when it expires;
- validates declared output schemas;
- normalizes failures into `ToolCallResult` instead of throwing.

Tools must cooperate with `context.signal`. A runtime can stop waiting at a
deadline, but it cannot undo external side effects from a tool that ignores
cancellation.

## Combining runtimes

`CompositeToolRuntime` merges dispatch surfaces, rejects name collisions, and
forwards all execution options to the selected child runtime:

```ts
const tools = new CompositeToolRuntime([
  domainTools,
  readOnlyTools,
]);
```

The composite does not evaluate policy. Policy is evaluated once by the kernel.

## Built-in host runtimes

Agentic includes filesystem, shell, fetch, search, web, and skill runtimes for
experimentation. They provide powerful host access and are not a security
sandbox. In particular:

- shell commands execute with host-process authority;
- network tools can reach URLs visible to the host;
- lexical path checks are not a substitute for OS sandboxing.

Production applications should expose narrow domain tools or place host tools
behind an external sandbox and explicit policy.

## Trust tiers

| Tier | Meaning |
|---|---|
| `trusted` | Internal deterministic operation |
| `standard` | Caller-provided operation with known behavior |
| `untrusted` | External service or untrusted content boundary |

Trust tiers are policy input. They do not grant authority by themselves.
