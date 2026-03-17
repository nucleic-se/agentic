/**
 * Agent hooks — extension points for the kernel.
 *
 * Hooks run at well-defined points in the deliberate → plan → execute →
 * reconcile loop. They are optional and additive — the kernel behaves
 * identically when no hooks are configured.
 *
 * Ordering:
 *   1. onBeforeLlmCall — before provider.turn()
 *   2. IToolPolicy.evaluate() — formal policy gate (Phase B)
 *   3. confirmToolCall — only if policy returned 'confirm'
 *   4. beforeToolCall — after policy, before tools.call()
 *   5. tools.call()
 *   6. afterToolCall — after tools.call()
 */

import type { ToolTrustTier } from '../../contracts/ITool.js'
import type { ToolCallResult } from '../../contracts/tool-runtime.js'
import type { Message } from '../../contracts/llm.js'

// ── Before tool call ──────────────────────────────────────────────────────────

export interface BeforeToolCallContext {
  callId:    string
  name:      string
  args:      Record<string, unknown>
  trustTier: ToolTrustTier
}

export type BeforeToolCallResult =
  | { action: 'proceed' }
  | { action: 'proceed'; args: Record<string, unknown> }
  | { action: 'skip'; reason: string }

// ── After tool call ───────────────────────────────────────────────────────────

export interface AfterToolCallContext {
  callId:    string
  name:      string
  args:      Record<string, unknown>
  result:    ToolCallResult
  latencyMs: number
}

export type AfterToolCallResult =
  | void
  | { result: ToolCallResult }

// ── Confirmation ──────────────────────────────────────────────────────────────

export interface ConfirmToolCallContext {
  callId:    string
  name:      string
  args:      Record<string, unknown>
  trustTier: ToolTrustTier
  reason:    string   // why the policy requested confirmation
}

// ── Before LLM call ──────────────────────────────────────────────────────────

export type OnBeforeLlmCallHook = (messages: Message[]) => Promise<Message[]> | Message[]
