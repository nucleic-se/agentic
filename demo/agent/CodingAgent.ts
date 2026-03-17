/**
 * CodingAgent — stateful wrapper around the execution kernel.
 *
 * Owns the three stores:
 *   - conversation:  protocol transcript (Message[]) — never trimmed
 *   - executions:    operational truth (TurnRecord[]) — one per turn
 *   - (Phase C) summaries: Map<string, TurnSummary> — broker inputs
 *
 * Phase A: context assembly is trivial — raw conversation passed directly.
 * Phase C+: contextBroker.assemble() is called here before runKernel().
 */

import type { Message }         from '../../contracts/llm.js'
import type { IAgent, AgentEventSink, TurnRecord, Failure } from '../../contracts/agent.js'
import type { AgentConfig }     from './config.js'
import { runKernel }            from './kernel.js'

const noop: AgentEventSink = () => {}

export class CodingAgent implements IAgent {
  private conversation: Message[]     = []   // protocol transcript — never trimmed
  private executions:   TurnRecord[]  = []   // operational truth — one per turn
  // Phase C adds: private summaries: Map<string, TurnSummary> = new Map()

  constructor(private readonly config: AgentConfig) {}

  async prompt(input: string, sink?: AgentEventSink): Promise<TurnRecord[]> {
    this.conversation.push({ role: 'user', content: input })
    return this._run(input, sink ?? noop)
  }

  async continue(sink?: AgentEventSink): Promise<TurnRecord[]> {
    return this._run(null, sink ?? noop)
  }

  private async _run(userInput: string | null, emit: AgentEventSink): Promise<TurnRecord[]> {
    const before = this.executions.length
    await emit({ type: 'agent_start' })
    try {
      // Phase A: pass raw conversation directly as model-visible messages.
      // Phase C+: contextBroker.assemble(this._buildQuery(userInput)) replaces this block.
      // A context_error (broker throws) fires here — before turn_start — so no TurnRecord.
      const context: { system?: string; messages: Message[] } = {
        system:   this.config.systemPrompt,
        messages: this.conversation,
      }

      const records = await runKernel(
        this.conversation,  // mutable — kernel appends at reconcile
        this.config,
        context,
        emit,
      )

      for (const r of records) this.executions.push(r)
      return this.executions.slice(before)
    } catch (e) {
      // Unhandled exception from kernel — unknown_error.
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
    // Phase C: this.summaries?.clear()
  }
}
