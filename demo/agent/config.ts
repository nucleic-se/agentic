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
  // tracer?: ISpanTracer

  // ── Phase E ─────────────────────────────────────────────────────────────────
  // factStore?: FactStore           // scratchpad + facts

  // ── Phase F ─────────────────────────────────────────────────────────────────
  // beforeToolCall?:    (ctx: BeforeToolCallContext)  => Promise<BeforeToolCallResult>
  // afterToolCall?:     (ctx: AfterToolCallContext)   => Promise<AfterToolCallResult | void>
  // transformMessages?: (messages: Message[])         => Promise<Message[]>
  // onBeforeLlmCall?:   (messages: Message[])         => Promise<Message[]>
  // steeringMode?:      'all' | 'one-at-a-time'       // default: 'all'
  // followUpMode?:      'all' | 'one-at-a-time'       // default: 'one-at-a-time'
}
