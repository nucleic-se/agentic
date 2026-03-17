/**
 * CodingAgent — stateful wrapper around the execution kernel.
 *
 * Owns the three stores:
 *   - conversation:  protocol transcript (Message[]) — never trimmed
 *   - executions:    operational truth (TurnRecord[]) — one per turn
 *   - summaries:     lossy context hints (Map<turnId, TurnSummary>)
 *
 * Phase C: contextBroker.assemble() is called via getContext() factory
 * before each turn. SessionFileTracker updated on turn_end. Summaries
 * generated fire-and-forget post-turn via the fast model tier.
 *
 * Phase D: optional ISpanTracer wired into emit — hierarchical spans
 * for agent/turn/tool events. Zero cost when tracer is absent.
 */

import { randomUUID }           from 'node:crypto'
import type { Message }         from '../../contracts/llm.js'
import type { IAgent, AgentEventSink, TurnRecord, Failure } from '../../contracts/agent.js'
import type { ISpanTracer }     from '../../contracts/IObservability.js'
import type { AgentConfig }     from './config.js'
import { runKernel }            from './kernel.js'
import { SessionFileTracker }   from './session-file-tracker.js'
import { DefaultContextBroker } from './context-broker.js'
import type { ContextBroker }   from './context-broker.js'
import { summarizeTurn, shouldSummarize } from './turn-summarizer.js'
import type { TurnSummary }     from './turn-summarizer.js'

const noop: AgentEventSink = () => {}

export class CodingAgent implements IAgent {
  private conversation: Message[]                    = []
  private executions:   TurnRecord[]                 = []
  private summaries:    Map<string, TurnSummary>     = new Map()
  private fileTracker:  SessionFileTracker           = new SessionFileTracker()
  private broker:       ContextBroker | null         = null

  constructor(private readonly config: AgentConfig) {}

  async prompt(input: string, sink?: AgentEventSink): Promise<TurnRecord[]> {
    this.conversation.push({ role: 'user', content: input })
    return this._run(sink ?? noop)
  }

  async continue(sink?: AgentEventSink): Promise<TurnRecord[]> {
    return this._run(sink ?? noop)
  }

  private _getBroker(): ContextBroker {
    if (!this.broker) {
      this.broker = this.config.contextBroker ?? new DefaultContextBroker(
        this.config.systemPrompt ?? '',
        this.fileTracker,
        this.config.tailTurns,
        this.config.promptEngine,
      )
    }
    return this.broker
  }

  private _getLatestUserInput(): string {
    for (let i = this.conversation.length - 1; i >= 0; i--) {
      const msg = this.conversation[i]
      if (msg?.role === 'user' && typeof msg.content === 'string') return msg.content
    }
    return ''
  }

  private _orderedSummaries(): TurnSummary[] {
    return this.executions
      .filter(r => this.summaries.has(r.turnId))
      .map(r => this.summaries.get(r.turnId)!)
  }

  private async _run(emit: AgentEventSink): Promise<TurnRecord[]> {
    const before = this.executions.length
    const tracer = this.config.tracer
    const correlationId = randomUUID()

    // Active span IDs for hierarchical tracing.
    let agentSpanId: string | undefined
    let turnSpanId:  string | undefined
    const toolSpans = new Map<string, string>()  // callId → spanId

    // Wrap emit for Phase C (file tracking, summarization) and Phase D (tracing).
    const wrappedEmit: AgentEventSink = async (event) => {
      // ── Phase D: open/close spans ──────────────────────────────────────
      if (tracer) {
        switch (event.type) {
          case 'agent_start':
            agentSpanId = tracer.startSpan({
              correlationId, type: 'agent-run',
              startTime: Date.now(), metadata: {},
            })
            break

          case 'turn_start':
            turnSpanId = tracer.startSpan({
              correlationId, type: 'agent-turn',
              parentSpanId: agentSpanId,
              startTime: Date.now(),
              metadata: { turnId: event.turnId },
            })
            break

          case 'tool_start': {
            const sid = tracer.startSpan({
              correlationId, type: `agent-tool.${event.name}`,
              parentSpanId: turnSpanId,
              startTime: Date.now(),
              metadata: { callId: event.callId, name: event.name },
            })
            toolSpans.set(event.callId, sid)
            break
          }

          case 'tool_end': {
            const sid = toolSpans.get(event.callId)
            if (sid) {
              const ok = event.execution.status === 'success'
              tracer.endSpan(sid, ok ? 'ok' : 'error', ok ? undefined : event.execution.error)
              toolSpans.delete(event.callId)
            }
            break
          }

          case 'turn_end':
            if (turnSpanId) {
              const ok = event.record.outcome === 'answered' || event.record.outcome === 'partial'
              tracer.endSpan(turnSpanId, ok ? 'ok' : 'error',
                ok ? undefined : event.record.failure?.message)
              turnSpanId = undefined
            }
            break

          case 'error':
            // Close any dangling turn span.
            if (turnSpanId) {
              tracer.endSpan(turnSpanId, 'error', event.failure.message)
              turnSpanId = undefined
            }
            break

          case 'agent_end':
            if (agentSpanId) {
              tracer.endSpan(agentSpanId, 'ok')
              agentSpanId = undefined
            }
            break
        }
      }

      // ── Forward to caller ──────────────────────────────────────────────
      await emit(event)

      // ── Phase C: file tracking + summarization ─────────────────────────
      if (event.type === 'turn_end') {
        for (const ex of event.record.executions) {
          if (ex.status === 'success') {
            this.fileTracker.record(ex.plan.name, ex.plan.input as Record<string, unknown>)
          }
        }
        if (shouldSummarize(event.record)) {
          summarizeTurn(event.record, this.config.router)
            .then(summary => this.summaries.set(summary.turnId, summary))
            .catch(() => { /* ignore — summaries are best-effort */ })
        }
      }
    }

    await wrappedEmit({ type: 'agent_start' })
    try {
      const broker = this._getBroker()

      const records = await runKernel(
        this.conversation,
        this.config,
        () => broker.assemble({
          userInput:     this._getLatestUserInput(),
          conversation:  this.conversation,
          turnSummaries: this._orderedSummaries(),
          tokenBudget:   this.config.tokenBudget ?? 28_000,
        }).then(assembled => ({
          system:      assembled.system,
          messages:    assembled.messages,
          contextUsed: assembled.selections,
        })),
        wrappedEmit,
      )

      for (const r of records) this.executions.push(r)
      return this.executions.slice(before)
    } catch (e) {
      const failure: Failure = {
        kind:    'unknown_error',
        message: e instanceof Error ? (e.stack ?? e.message) : String(e),
      }
      await wrappedEmit({ type: 'error', failure })
      return this.executions.slice(before)
    } finally {
      await wrappedEmit({ type: 'agent_end', records: this.executions })
    }
  }

  getConversation():     readonly Message[]    { return this.conversation }
  getExecutionHistory(): readonly TurnRecord[] { return this.executions }

  clearSession(): void {
    this.conversation = []
    this.executions   = []
    this.summaries    = new Map()
    this.fileTracker  = new SessionFileTracker()
    this.broker       = null
  }
}
