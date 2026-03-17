# Tool Policy

`IToolPolicy` is the formal safety layer between context assembly and tool execution. Before
a tool call is dispatched to `IToolRuntime`, the policy decides whether it should proceed,
have its arguments rewritten, be denied, or require user confirmation.

---

## Why policy is a separate primitive

Without an explicit policy layer, safety rules end up scattered across agent code: in the
tool loop, in hooks, in ad hoc `if` statements. `IToolPolicy` gives them a single, testable
home with a defined contract and clear semantics for each decision.

Policy evaluates *intent* — the planned call and its trust context — not implementation.
It does not execute tools.

---

## Interface

```ts
import type { IToolPolicy, PolicyContext, PolicyDecision } from '@nucleic-se/agentic/contracts'

interface PolicyContext {
    callId:    string             // LLM-assigned call ID
    name:      string             // tool name
    args:      Record<string, unknown>
    trustTier: ToolTrustTier      // from IToolRegistry: 'trusted' | 'standard' | 'untrusted'
}

type PolicyDecision =
    | { kind: 'allow' }
    | { kind: 'rewrite'; args: Record<string, unknown>; reason: string }
    | { kind: 'deny';    reason: string }
    | { kind: 'confirm'; reason: string }

interface IToolPolicy {
    evaluate(context: PolicyContext): Promise<PolicyDecision>
}
```

---

## Decisions

**`allow`** — the call proceeds with the original args.

**`rewrite`** — the call proceeds with substituted args. The original and rewritten args are
both recorded in execution history. Use this for normalising paths, sanitising inputs, or
capping parameters (e.g., limiting a file read to N bytes).

**`deny`** — the call is blocked. A synthetic `ToolResultMessage` is appended to the
conversation with the denial reason. The model sees the denial and can adapt. A denial is
not an agent error — it is the policy doing its job.

**`confirm`** — the agent loop pauses and requests user confirmation. The calling agent is
responsible for surfacing this to the user and resuming. The policy contract does not own
the interaction channel.

---

## Built-in implementations

```ts
import { PassThroughToolPolicy, TrustTierToolPolicy } from '@nucleic-se/agentic/runtime'
```

**`PassThroughToolPolicy`** — allows every call unconditionally. Suitable for controlled
environments where all tools are trusted.

**`TrustTierToolPolicy`** — denies calls to tools not registered in `IToolRegistry`. Allows
all known tools regardless of tier. Use as a base class to add tier-specific rules:

```ts
import { TrustTierToolPolicy } from '@nucleic-se/agentic/runtime'
import type { PolicyContext, PolicyDecision } from '@nucleic-se/agentic/contracts'

class ProductionPolicy extends TrustTierToolPolicy {
    async evaluate(ctx: PolicyContext): Promise<PolicyDecision> {
        // Require confirmation before any untrusted (external) tool call
        if (ctx.trustTier === 'untrusted') {
            return { kind: 'confirm', reason: 'External content requires approval' }
        }
        // Deny destructive shell commands
        if (ctx.name === 'shell_exec') {
            const cmd = ctx.args['command'] as string ?? ''
            if (/rm\s+-rf|mkfs|dd\s+if/.test(cmd)) {
                return { kind: 'deny', reason: 'Destructive command blocked by policy' }
            }
        }
        return super.evaluate(ctx)
    }
}
```

---

## Integration

Policy evaluation happens after the model proposes a tool call and before `IToolRuntime.call()`:

```
model response (tool_use) → policy.evaluate() → [allow/rewrite/deny/confirm] → tools.call()
```

When a call is denied or confirmed, the agent loop must generate a `ToolResultMessage` with
the appropriate content. The `TurnRecord` marks the execution as `status: 'policy_denied'`
or `status: 'pending_confirmation'`.
