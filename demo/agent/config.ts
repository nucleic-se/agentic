/**
 * AgentConfig — the full configuration surface for CodingAgent.
 *
 * Lives in demo/ because it references demo-layer types (ContextBroker,
 * FactStore, hook contexts) that have no place in contracts/. Not in contracts/.
 *
 * Fields are grouped by phase. Only Phase A fields are required; all others
 * are optional and ignored until the corresponding phase is implemented.
 */

import type { Message }        from '../../contracts/llm.js'
import type { IModelRouter }   from '../../contracts/llm.js'
import type { IToolRuntime }   from '../../contracts/tool-runtime.js'
import type { IToolPolicy }    from '../../contracts/IToolPolicy.js'
import type { IToolRegistry }  from '../../contracts/ITool.js'
import type { IPromptEngine }  from '../../contracts/IPromptEngine.js'
import type { ContextBroker }  from './context-broker.js'

// ── Phase A ───────────────────────────────────────────────────────────────────

export interface AgentConfig {
  // Required
  router: IModelRouter
  tools:  IToolRuntime

  // Optional
  systemPrompt?:        string
  maxTurns?:            number                    // default: 20
  autoStop?:            boolean                   // skip follow-up LLM call when all tools succeed and model produced no text
  getSteeringMessages?: () => Promise<Message[]>  // polled after each tool call
  getFollowUpMessages?: () => Promise<Message[]>  // polled after end_turn

  // ── Phase B ─────────────────────────────────────────────────────────────────
  policy?:   IToolPolicy    // default: PassThroughToolPolicy (allow all)
  registry?: IToolRegistry  // required for DefaultToolPolicy trust-tier resolution

  // ── Phase C ─────────────────────────────────────────────────────────────────
  contextBroker?: ContextBroker  // default: DefaultContextBroker
  promptEngine?:  IPromptEngine  // injected into DefaultContextBroker when provided
  tokenBudget?:   number         // default: 28_000
  tailTurns?:     number         // raw conversation turns in tail lane; default: 3

  // ── Phase D ─────────────────────────────────────────────────────────────────
  tracer?: import('../../contracts/IObservability.js').ISpanTracer

  // ── Phase E ─────────────────────────────────────────────────────────────────
  factStore?: import('./fact-store.js').FactStore

  // ── Phase F ─────────────────────────────────────────────────────────────────
  beforeToolCall?:   (ctx: import('./hooks.js').BeforeToolCallContext) => Promise<import('./hooks.js').BeforeToolCallResult> | import('./hooks.js').BeforeToolCallResult
  afterToolCall?:    (ctx: import('./hooks.js').AfterToolCallContext) => Promise<import('./hooks.js').AfterToolCallResult> | import('./hooks.js').AfterToolCallResult
  /** Called when IToolPolicy returns 'confirm'. Return true to proceed, false to deny. */
  confirmToolCall?:  (ctx: import('./hooks.js').ConfirmToolCallContext) => Promise<boolean> | boolean
  onBeforeLlmCall?:  import('./hooks.js').OnBeforeLlmCallHook
}
