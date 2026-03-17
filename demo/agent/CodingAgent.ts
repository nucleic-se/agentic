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
 */

import type { Message }         from '../../contracts/llm.js'
import type { IAgent, AgentEventSink, TurnRecord, Failure } from '../../contracts/agent.js'
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
    // Sort by position in execution history to preserve chronological order
    // despite fire-and-forget async delivery.
    return this.executions
      .filter(r => this.summaries.has(r.turnId))
      .map(r => this.summaries.get(r.turnId)!)
  }

  private async _run(emit: AgentEventSink): Promise<TurnRecord[]> {
    const before = this.executions.length

    // Wrap emit to intercept turn_end for file tracking + summarization.
    const wrappedEmit: AgentEventSink = async (event) => {
      await emit(event)
      if (event.type === 'turn_end') {
        // Update file tracker from successful tool calls.
        for (const ex of event.record.executions) {
          if (ex.status === 'success') {
            this.fileTracker.record(ex.plan.name, ex.plan.input as Record<string, unknown>)
          }
        }
        // Fire-and-forget summarization — summaries are hints, not ground truth.
        if (shouldSummarize(event.record)) {
          summarizeTurn(event.record, this.config.router)
            .then(summary => this.summaries.set(summary.turnId, summary))
            .catch(() => { /* ignore — summaries are best-effort */ })
        }
      }
    }

    await emit({ type: 'agent_start' })
    try {
      const broker = this._getBroker()

      const records = await runKernel(
        this.conversation,
        this.config,
        // getContext factory — called before each turn in the kernel loop.
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
      await emit({ type: 'error', failure })
      return this.executions.slice(before)
    } finally {
      await emit({ type: 'agent_end', records: this.executions })
    }
  }

  getConversation():     readonly Message[]    { return this.conversation }
  getExecutionHistory(): readonly TurnRecord[] { return this.executions }

  clearSession(): void {
    this.conversation = []
    this.executions   = []
    this.summaries    = new Map()
    this.fileTracker  = new SessionFileTracker()
    this.broker       = null  // force re-init with fresh fileTracker
  }
}
