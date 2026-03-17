/**
 * CodingAgent contracts — shared types for the agent runtime.
 *
 * Pure protocol types only. No imports from demo/. No implementation.
 *
 * Covers: state machine, tool planning, execution records, failure taxonomy,
 * event stream, and the IAgent interface.
 *
 * @module contracts
 */

import type { Message, AssistantMessage, TokenUsage, TurnRequest } from './llm.js'
import type { ToolCallResult } from './tool-runtime.js'
import type { ToolTrustTier } from './ITool.js'

// ── State machine ─────────────────────────────────────────────────────────────

/**
 * The kernel's internal state. Transitions are explicit; the loop is a driver.
 * State transitions are: idle → deliberating → planning → executing → reconciling → idle | done | failed | aborted.
 */
export type AgentState =
  | { kind: 'idle' }
  | { kind: 'deliberating';  turnId: string }
  | { kind: 'planning';      turnId: string; response: AssistantMessage }
  | { kind: 'executing';     turnId: string; plan: ToolPlan[]; completed: ToolExecution[] }
  | { kind: 'reconciling';   turnId: string; plan: ToolPlan[]; executions: ToolExecution[] }
  | { kind: 'done' }
  | { kind: 'failed';        failure: Failure }
  | { kind: 'aborted' }

// ── External artifact ─────────────────────────────────────────────────────────

/**
 * Typed external content from an untrusted tool result.
 * Implementation helpers (normalizeArtifact, labeledContent) live in demo/agent/artifact.ts.
 */
export interface ExternalArtifact {
  id:                   string
  source:               'fetch' | 'search' | 'shell' | 'fs'
  trustTier:            ToolTrustTier
  /** Possibly clipped content — this is what entered context. */
  content:              string
  /** Byte offset at which content was clipped, if truncation occurred. */
  clippedAt?:           number
  /** Phase F: path to a temp file holding the full response body. */
  fullContentPath?:     string
  metadata:             Record<string, unknown>
  /** Heuristic: content appears to contain imperative instructions. */
  containsInstructions: boolean
  timestamp:            number
}

// ── Tool plan and execution ───────────────────────────────────────────────────

/**
 * A tool call the model planned to make. Recorded regardless of whether it
 * ran — the execution store is authoritative for what actually happened.
 */
export interface ToolPlan {
  callId:     string
  name:       string
  input:      unknown
  /** Phase B: trust tier resolved from IToolRegistry at plan time. */
  trustTier?: ToolTrustTier
}

export type ToolExecutionStatus =
  | 'success'          // tools.call() returned ok: true
  | 'runtime_failure'  // tools.call() returned ok: false
  | 'timeout'          // tool exceeded timeoutMs — did not return
  | 'policy_denied'    // Phase B — ToolPolicy denied or confirmed-as-deny
  | 'cancelled'        // AbortSignal fired before this call ran
  | 'skipped'          // steering interrupted before this call ran

export interface ToolExecution {
  callId:     string
  plan:       ToolPlan
  status:     ToolExecutionStatus
  result?:    ToolCallResult
  latencyMs?: number
  /** Error message for runtime_failure / timeout; denial reason for policy_denied. */
  error?:     string
  /**
   * Phase B: set for untrusted tool results. Carries provenance metadata,
   * clipping info, and the containsInstructions flag. The ToolResultMessage
   * in conversation uses labeledContent(artifact) — not the raw result string.
   */
  artifact?:  ExternalArtifact
}

// ── Context selection ─────────────────────────────────────────────────────────

export type ContextSource =
  | 'system_prompt'
  | 'session_file_tracker'
  | 'turn_summary'
  | 'raw_turn'
  | 'fact'
  | 'semantic'

export type CandidateLane =
  | 'sticky'
  | 'must_include'
  | 'historical'
  | 'semantic'
  | 'tail'
  | 'working_state'

export interface ContextScore {
  recency:   number  // 0–1
  relevance: number  // 0–1
  authority: number  // 0–1
}

export interface ContextCandidate {
  source:      ContextSource
  content:     string
  lane:        CandidateLane
  mustInclude: boolean
  score:       ContextScore
  metadata:    Record<string, unknown>
}

// ── Failure ───────────────────────────────────────────────────────────────────

export type FailureKind =
  | 'llm_transport_error'  // provider.turn() threw — infrastructure failure
  | 'llm_protocol_error'   // response unparsable / contract violation
  | 'tool_timeout'         // tool didn't return within timeoutMs
  | 'max_turns_exceeded'   // safety turn limit reached
  | 'max_tokens_stop'      // model output was truncated
  | 'context_error'        // ContextBroker.assemble() threw before turn_start
  | 'abort'                // AbortSignal fired
  | 'unknown_error'        // unrecognised exception; promote to named category on investigation

export interface Failure {
  kind:    FailureKind
  /** Human-readable description. Includes full stack trace for unknown_error. */
  message: string
}

// ── Turn record ───────────────────────────────────────────────────────────────

/**
 * The outcome of a single turn. Applies only to turns that started (turn_start
 * was emitted). Agent-level errors that fire before turn_start (max_turns_exceeded,
 * context_error) produce no TurnRecord — only an error event and agent_end.
 */
export type TurnOutcome =
  | 'answered'     // completed normally (end_turn, stop_sequence, or all tools ran)
  | 'partial'      // max_tokens_stop; response truncated; agent stops safely
  | 'failed'       // llm_transport_error, llm_protocol_error, unknown_error
  | 'aborted'      // AbortSignal fired; synthetic results for all unrun calls
  | 'interrupted'  // steering interruption; session continues; synthetic results for skipped calls

// NOTE: 'terminated' is NOT a TurnOutcome. max_turns_exceeded fires at the loop
// guard between turns — no turn_start has been emitted, so no TurnRecord is created.
// The agent emits { type: 'error', failure: { kind: 'max_turns_exceeded' } } followed
// by agent_end, and stops. The last committed TurnRecord has outcome='answered'.
// Similarly, context_error fires before turn_start — no TurnRecord, only error + agent_end.

/**
 * The canonical debug object. Generated for every turn, regardless of outcome.
 * Immutable after write. Captures exactly what was sent and what came back.
 */
export interface TurnRecord {
  turnId:        string
  userInput:     string | null       // null for continue()
  modelRequest:  TurnRequest         // exactly what was sent to the provider
  modelResponse: AssistantMessage    // exactly what came back
  plan:          ToolPlan[]          // all calls the model planned (including unexecuted)
  executions:    ToolExecution[]     // what actually ran (may be partial if interrupted)
  outcome:       TurnOutcome
  failure?:      Failure
  /** Set when steering or AbortSignal broke mid-execution. */
  interrupted?: {
    plannedCalls:  string[]          // all call IDs the model intended
    executedCalls: string[]          // those that actually ran
    reason:        'steering' | 'abort'
    // Note: policy denials (status='policy_denied') do NOT set interrupted —
    // they mark individual calls and execution continues for remaining calls.
  }
  durationMs:   number
  tokenUsage:   TokenUsage
  /** Phase C: which context candidates were assembled for this turn. */
  contextUsed?: ContextCandidate[]
}

// ── Events ────────────────────────────────────────────────────────────────────

/**
 * The event stream emitted by the agent during a run.
 *
 * Guaranteed ordering per run:
 *   agent_start
 *   (turn_start, message_end?, tool_start*, tool_end*, turn_end)*
 *   error?          — only on terminal failure; always followed by agent_end
 *   agent_end
 *
 * Every turn_start has a matching turn_end or a terminal error — never both, never neither.
 */
export type AgentEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end';   records: TurnRecord[] }
  | { type: 'turn_start';  turnId: string }
  | { type: 'turn_end';    record: TurnRecord }
  | { type: 'message_delta'; text: string }
  | { type: 'message_end'; message: AssistantMessage }
  | { type: 'tool_start';  turnId: string; callId: string; name: string; input: unknown }
  | { type: 'tool_end';    turnId: string; callId: string; name: string; execution: ToolExecution }
  | { type: 'error';       failure: Failure }

export type AgentEventSink = (event: AgentEvent) => void | Promise<void>

// ── IAgent ────────────────────────────────────────────────────────────────────

export interface IAgent {
  /**
   * Append a user message and run until the agent reaches end_turn or a
   * terminal failure. Returns the TurnRecord(s) produced during this call.
   */
  prompt(input: string, sink?: AgentEventSink): Promise<TurnRecord[]>

  /**
   * Resume without appending a new user message — used when the agent was
   * interrupted or when driving continuation from an external signal.
   */
  continue(sink?: AgentEventSink): Promise<TurnRecord[]>

  /** The full LLM-visible conversation history. Never trimmed. */
  getConversation(): readonly Message[]

  /** Full execution history — one TurnRecord per turn, always. */
  getExecutionHistory(): readonly TurnRecord[]

  /** Reset all stores — conversation, execution history, and (Phase C) summaries. */
  clearSession(): void
}
