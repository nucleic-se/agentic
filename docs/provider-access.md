# Provider access

Agentic supports explicit provider and authentication choices. All four run through Agentic's own model/tool loop, approvals, context preparation and execution receipts.

| Provider | Authentication | Access source |
|---|---|---|
| OpenAI | `api-key` | Explicit key, `AGENTIC_OPENAI_API_KEY`, then `OPENAI_API_KEY` |
| OpenAI | `subscription` | Existing Codex login, or caller-supplied credential callback |
| Anthropic | `api-key` | Explicit key, `AGENTIC_ANTHROPIC_API_KEY`, then `ANTHROPIC_API_KEY` |
| Anthropic | `subscription` | Anthropic OAuth login through the optional Pi-backed adapter |

Choose the mode explicitly. Missing or expired subscription access never triggers API-key fallback, and API-key mode never searches subscription credentials. Model availability and usage limits depend on the selected account. API billing is separate from subscription allowances.

## Reference CLI

The reference CLI defaults to OpenAI subscription access with `gpt-6-astra` and sessions under `~/.agentic`:

```sh
npm run agent -- --workspace /project
```

Log in to Anthropic once, then choose a model available to your subscription:

```sh
npm run agent -- --provider anthropic --login
npm run agent -- --provider anthropic --auth subscription --model claude-sonnet-4-6 --workspace /project
```

Login prints a browser URL and accepts the callback/code if needed. It makes no model request. Agentic stores Anthropic credentials in `~/.agentic/anthropic-auth.json` with private file permissions, refreshing them under an exclusive file lock. `--auth-file PATH` selects a dedicated alternative Agentic store. Do not point this at an auth file concurrently managed by Pi or another application: those writers may use a different locking protocol. Library consumers can inject their existing coordinated credential store instead.

For OpenAI subscription access, `npm run agent -- --provider openai --login` launches the installed `codex login` command. The normal provider continues to use the existing Codex auth location; `--auth-file PATH` can select an existing Codex auth file. No credentials are migrated or copied between accounts.

For either API provider, set its environment variable and supply a model and working context budget:

```sh
# Set OPENAI_API_KEY using your normal secret-management workflow.
npm run agent -- --provider openai --auth api-key --model YOUR_OPENAI_MODEL --context-tokens 32000 --workspace /project

# Set ANTHROPIC_API_KEY using your normal secret-management workflow.
npm run agent -- --provider anthropic --auth api-key --model claude-sonnet-4-6 --context-tokens 32000 --workspace /project
```

`--context-tokens` must fit the model's capacity and includes reserved output. API adapters do not advertise model capacity, so the CLI requires this explicit value. The subscription adapters use their model catalogs where available. Switching provider/auth mode uses a separate default session directory under `~/.agentic`; `--data PATH` overrides it. Saved sessions still require matching composition identity.

The library coding preset retains its existing default for backward compatibility; use `selectProvider` to choose Anthropic explicitly when embedding.

## Library selection

```ts
import { selectProvider } from '@nucleic-se/agentic/providers/select';
import { createDefaultAgent } from '@nucleic-se/agentic/coding';

const provider = await selectProvider({
  provider: 'anthropic',
  auth: 'api-key',
  model: 'claude-sonnet-4-6',
  // apiKey is optional when the corresponding environment variable is set.
});
const agent = await createDefaultAgent({ workspace, provider, tokenBudget: 32000 });
try {
  // Create a session, submit work, then await agent.wait(session.id).
} finally {
  await agent.close();
}
```

The selector preserves existing provider constructors. It loads subscription dependencies only for subscription branches. API selections expose a non-secret configuration identity independent of key rotation. Opaque behavior overrides such as custom headers, extra request bodies or retry callbacks require an explicit `providerIdentity`; the application must identify their behavior without including credentials.

Anthropic subscription authentication is application-owned:

```ts
import {
  FileCredentialStore,
  createAnthropicSubscriptionAuth,
} from '@nucleic-se/agentic/providers/anthropic-subscription';

const auth = createAnthropicSubscriptionAuth(new FileCredentialStore('/private/agentic-auth.json'));
// Once, connect your UI's prompt/notification callbacks:
await auth.login({ prompt, notify });

const provider = await selectProvider({
  provider: 'anthropic',
  auth: 'subscription',
  model: 'claude-sonnet-4-6',
  credentials: auth.credentials,
});
```

`login` supports a cancellation signal. `credentials` resolves and refreshes OAuth only; it does not fall back to stored API keys or ambient API-key variables. The helper also accepts a Pi-compatible `CredentialStore` supplied by the application. Its `modify` operation must serialize credential updates, including refresh-token rotation. A file-store lock left by a crashed process fails closed until the application/operator reconciles it; it is not automatically stolen.

For OpenAI subscription selection, use `{ provider: 'openai', auth: 'subscription', model }` with optional `authFilePath` or `credentials`. Existing direct `SubscriptionProvider`, `AnthropicProvider` and `OpenAICompatibleProvider` imports remain supported.

## Optional backend and protocol limits

Subscription adapters use the pinned optional `@earendil-works/pi-ai@0.85.1` backend. Install it in applications choosing those paths. OpenAI subscription access retains its existing Node 22.19+ backend requirement. API-only and empty-core consumers do not load Pi.

The Anthropic subscription adapter sends native model/tool requests; it does not launch Claude Code or delegate Agentic's loop. Pi's OAuth transport adds Claude Code identity headers and a system-prompt prefix. That is a backend behavior, not a claim that Agentic is an official Anthropic client. Anthropic's access rules and billing can change independently of Agentic; see its [authentication guidance](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account) and [subscription/SDK usage update](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan). Keep this transport distinction visible in benchmark configurations.

The new adapter preserves signed thinking and tool-result image blocks through explicit message replay. It rejects opaque response-ID continuation and unsupported stop-sequence requests. Structured output uses a forced native result tool; combinations that cannot preserve that contract are rejected instead of silently changing thinking settings. Pi may repair incomplete tool-argument JSON before Agentic receives it; Agentic's normal tool-schema validation still applies. Request observers see decoded request bodies, never authentication headers. No live-account success is implied by the deterministic adapter tests.
