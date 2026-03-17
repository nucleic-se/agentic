/**
 * CodingAgent execution kernel.
 *
 * Pure function — no class state, no side effects beyond appending to the
 * mutable `conversation` array passed in. Drives the deliberate → plan →
 * execute → reconcile loop with explicit turn records.
 *
 * Phase A: core loop.
 * Phase B: policy gate + trust tier assignment + ExternalArtifact normalization.
 * Phase C+: context broker, observability, memory layered on by CodingAgent.
 */

import { randomUUID }                  from 'node:crypto'
import type { Message, AssistantMessage, ToolResultMessage } from '../../contracts/llm.js'
import type { AgentConfig }            from './config.js'
import type {
  AgentEventSink,
  TurnRecord,
  ToolPlan,
  ToolExecution,
  ToolExecutionStatus,
  Failure,
  ContextCandidate,
} from '../../contracts/agent.js'
import { normalizeArtifact, labeledContent } from './artifact.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function syntheticResult(callId: string, content: string): ToolResultMessage {
  return { role: 'tool_result', toolCallId: callId, content, isError: true }
}

function realResult(callId: string, content: string, isError: boolean): ToolResultMessage {
  return { role: 'tool_result', toolCallId: callId, content, isError }
}

// ── Kernel context ────────────────────────────────────────────────────────────

interface KernelContext {
  system?:      string
  messages:     Message[]
  contextUsed?: ContextCandidate[]
}

// ── Kernel ────────────────────────────────────────────────────────────────────

/**
 * Run the deliberate → plan → execute → reconcile loop.
 *
 * @param conversation  Mutable transcript. Kernel appends messages at reconcile.
 * @param config        Agent configuration.
 * @param getContext    Called before each turn to assemble model-visible context.
 *                      Throwing here emits context_error and stops — no TurnRecord.
 * @param emit          Event sink — called for every agent event.
 * @param signal        Optional cancellation signal.
 * @returns             All TurnRecords produced during this run.
 */
export async function runKernel(
  conversation: Message[],
  config:       AgentConfig,
  getContext:   () => Promise<KernelContext> | KernelContext,
  emit:         AgentEventSink,
  signal?:      AbortSignal,
): Promise<TurnRecord[]> {
  const records: TurnRecord[] = []
  const maxTurns = config.maxTurns ?? 20

  // Outer turn loop — each iteration is one model call + execution cycle.
  while (true) {
    // ── Max-turns guard ───────────────────────────────────────────────────────
    // Fires between turns, before turn_start is emitted — no TurnRecord created.
    if (records.length >= maxTurns) {
      const failure: Failure = { kind: 'max_turns_exceeded', message: `Reached turn limit of ${maxTurns}` }
      await emit({ type: 'error', failure })
      return records
    }

    // ── Abort guard ───────────────────────────────────────────────────────────
    if (signal?.aborted) {
      const failure: Failure = { kind: 'abort', message: 'AbortSignal fired before turn started' }
      await emit({ type: 'error', failure })
      return records
    }

    // ── Context assembly ─────────────────────────────────────────────────────
    // Fires before turn_start — context_error produces no TurnRecord.
    let context: KernelContext
    try {
      context = await getContext()
    } catch (e) {
      const failure: Failure = {
        kind:    'context_error',
        message: e instanceof Error ? e.message : String(e),
      }
      await emit({ type: 'error', failure })
      return records
    }

    const turnId = randomUUID()
    const t0     = Date.now()

    await emit({ type: 'turn_start', turnId })

    // ────────────────────────────────────────────────────────────────────────
    // Step 1: Deliberate — call the provider
    // ────────────────────────────────────────────────────────────────────────
    const provider = config.router.select('balanced')

    // Phase F: onBeforeLlmCall hook — transform messages before provider call.
    let llmMessages = context.messages
    if (config.onBeforeLlmCall) {
      llmMessages = await config.onBeforeLlmCall(context.messages)
    }

    const turnRequest: import('../../contracts/llm.js').TurnRequest = {
      system:   context.system,
      messages: llmMessages,
      tools:    config.tools.tools(),
    }

    let turnResponse: Awaited<ReturnType<typeof provider.turn>>
    try {
      if (provider.streamTurn) {
        turnResponse = await provider.streamTurn(turnRequest, (text) => {
          emit({ type: 'message_delta', text })
        })
      } else {
        turnResponse = await provider.turn(turnRequest)
      }
    } catch (e) {
      // llm_transport_error or llm_protocol_error — terminal
      const isProtocol = e instanceof Error && e.message.includes('protocol')
      const kind = isProtocol ? 'llm_protocol_error' : 'llm_transport_error'
      const failure: Failure = {
        kind,
        message: e instanceof Error ? e.message : String(e),
      }
      // Commit a TurnRecord — turn_start was emitted so a record is required.
      const record: TurnRecord = {
        turnId,
        userInput:     null,
        modelRequest:  { system: context.system, messages: context.messages, tools: config.tools.tools() },
        modelResponse: { role: 'assistant', content: '' },
        plan:          [],
        executions:    [],
        outcome:       'failed',
        failure,
        durationMs:    Date.now() - t0,
        tokenUsage:    { inputTokens: 0, outputTokens: 0 },
        contextUsed:   context.contextUsed,
      }
      records.push(record)
      await emit({ type: 'turn_end', record })
      await emit({ type: 'error', failure })
      return records
    }

    const { message: response, stopReason, usage } = turnResponse
    await emit({ type: 'message_end', message: response })

    // ────────────────────────────────────────────────────────────────────────
    // Step 2: Plan — interpret stop reason
    // ────────────────────────────────────────────────────────────────────────

    if (stopReason === 'max_tokens') {
      const failure: Failure = { kind: 'max_tokens_stop', message: 'Model output truncated at token limit' }
      const record: TurnRecord = {
        turnId,
        userInput:     null,
        modelRequest:  { system: context.system, messages: context.messages, tools: config.tools.tools() },
        modelResponse: response,
        plan:          [],
        executions:    [],
        outcome:       'partial',
        failure,
        durationMs:    Date.now() - t0,
        tokenUsage:    usage,
        contextUsed:   context.contextUsed,
      }
      records.push(record)
      await emit({ type: 'turn_end', record })
      await emit({ type: 'error', failure })
      return records
    }

    if (stopReason === 'end_turn' || stopReason === 'stop_sequence') {
      // Natural stop — commit turn, then check for follow-ups.
      conversation.push(response)
      const record: TurnRecord = {
        turnId,
        userInput:     null,
        modelRequest:  { system: context.system, messages: context.messages, tools: config.tools.tools() },
        modelResponse: response,
        plan:          [],
        executions:    [],
        outcome:       'answered',
        durationMs:    Date.now() - t0,
        tokenUsage:    usage,
        contextUsed:   context.contextUsed,
      }
      records.push(record)
      await emit({ type: 'turn_end', record })

      // Check for follow-up messages — each response is a separate turn.
      const followUps = config.getFollowUpMessages ? await config.getFollowUpMessages() : []
      if (followUps.length > 0) {
        for (const msg of followUps) conversation.push(msg)
        // getContext() will be called at the start of the next iteration.
        continue
      }

      return records
    }

    // stopReason === 'tool_use'

    // Deduplicate tool calls by callId within this response (protocol safety).
    const seen    = new Set<string>()
    const rawCalls = response.toolCalls ?? []
    const uniqueCalls = rawCalls.filter(c => {
      if (seen.has(c.id)) return false
      seen.add(c.id)
      return true
    })

    // Phase B: resolve trust tier from registry at plan time.
    const plan: ToolPlan[] = uniqueCalls.map(c => ({
      callId:    c.id,
      name:      c.name,
      input:     c.args,
      trustTier: config.registry?.resolve(c.name)?.trustTier ?? 'standard',
    }))

    // ────────────────────────────────────────────────────────────────────────
    // Step 3: Execute — run each planned tool call
    // ────────────────────────────────────────────────────────────────────────
    const executions: ToolExecution[] = []
    let interruptReason: 'abort' | 'steering' | null = null
    let steeringMessages: Message[] = []

    for (const p of plan) {
      // Abort check before each call.
      if (signal?.aborted) {
        // Mark this and all remaining as cancelled.
        const remaining = plan.slice(executions.length)
        for (const rem of remaining) {
          executions.push({ callId: rem.callId, plan: rem, status: 'cancelled' })
        }
        interruptReason = 'abort'
        break
      }

      // Phase B: policy gate — evaluate before each call.
      if (config.policy) {
        const decision = await config.policy.evaluate({
          callId:    p.callId,
          name:      p.name,
          args:      p.input as Record<string, unknown>,
          trustTier: p.trustTier ?? 'standard',
        })
        if (decision.kind === 'deny') {
          const execution: ToolExecution = {
            callId: p.callId, plan: p, status: 'policy_denied', error: decision.reason,
          }
          executions.push(execution)
          await emit({ type: 'tool_end', turnId, callId: p.callId, name: p.name, execution })
          continue
        }
        if (decision.kind === 'confirm') {
          // Phase F: real confirmation channel. Falls back to deny if no hook.
          const confirmed = config.confirmToolCall
            ? await config.confirmToolCall({
                callId: p.callId, name: p.name,
                args: p.input as Record<string, unknown>,
                trustTier: p.trustTier ?? 'standard',
                reason: decision.reason,
              })
            : false
          if (!confirmed) {
            const execution: ToolExecution = {
              callId: p.callId, plan: p, status: 'policy_denied',
              error: `Confirmation denied: ${decision.reason}`,
            }
            executions.push(execution)
            await emit({ type: 'tool_end', turnId, callId: p.callId, name: p.name, execution })
            continue
          }
          // Confirmed — fall through to execution.
        }
        if (decision.kind === 'rewrite') {
          (p as { input: unknown }).input = decision.args
        }
        // decision.kind === 'allow' or confirmed → fall through
      }

      // Phase F: beforeToolCall hook — runs after policy, can skip or modify args.
      if (config.beforeToolCall) {
        const hookResult = await config.beforeToolCall({
          callId: p.callId, name: p.name,
          args: p.input as Record<string, unknown>,
          trustTier: p.trustTier ?? 'standard',
        })
        if (hookResult.action === 'skip') {
          const execution: ToolExecution = {
            callId: p.callId, plan: p, status: 'skipped', error: hookResult.reason,
          }
          executions.push(execution)
          await emit({ type: 'tool_end', turnId, callId: p.callId, name: p.name, execution })
          continue
        }
        if ('args' in hookResult && hookResult.args) {
          (p as { input: unknown }).input = hookResult.args
        }
      }

      await emit({ type: 'tool_start', turnId, callId: p.callId, name: p.name, input: p.input })

      const callT0 = Date.now()
      let execution: ToolExecution

      try {
        const raw = await config.tools.call(p.name, p.input as Record<string, unknown>, { signal })

        // Phase B: normalize untrusted results into ExternalArtifact.
        const isUntrusted = (p.trustTier ?? 'standard') === 'untrusted'
        if (isUntrusted && raw.ok) {
          const artifact = normalizeArtifact(p.name, raw)
          execution = {
            callId:    p.callId,
            plan:      p,
            status:    'success',
            result:    { ...raw, content: labeledContent(artifact) },
            latencyMs: Date.now() - callT0,
            artifact,
          }
        } else {
          execution = {
            callId:    p.callId,
            plan:      p,
            status:    raw.ok ? 'success' : 'runtime_failure',
            result:    raw,
            latencyMs: Date.now() - callT0,
            ...(!raw.ok ? { error: raw.content } : {}),
          }
        }
      } catch (e) {
        execution = {
          callId:    p.callId,
          plan:      p,
          status:    'runtime_failure',
          latencyMs: Date.now() - callT0,
          error:     e instanceof Error ? e.message : String(e),
        }
      }

      // Phase F: afterToolCall hook — can modify the result.
      if (config.afterToolCall && execution.result) {
        const hookResult = await config.afterToolCall({
          callId: p.callId, name: p.name,
          args: p.input as Record<string, unknown>,
          result: execution.result,
          latencyMs: execution.latencyMs ?? 0,
        })
        if (hookResult && 'result' in hookResult) {
          execution = { ...execution, result: hookResult.result }
        }
      }

      executions.push(execution)
      await emit({ type: 'tool_end', turnId, callId: p.callId, name: p.name, execution })

      // Check for steering interruption after each tool call.
      if (config.getSteeringMessages) {
        const steering = await config.getSteeringMessages()
        if (steering.length > 0) {
          // Mark remaining planned calls as skipped.
          const remaining = plan.slice(executions.length)
          for (const rem of remaining) {
            executions.push({ callId: rem.callId, plan: rem, status: 'skipped' })
          }
          steeringMessages = steering
          interruptReason = 'steering'
          break
        }
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // Step 4: Reconcile — commit turn atomically
    //
    // Protocol rule: every tool_use in an AssistantMessage MUST have a
    // corresponding ToolResultMessage. Cancelled/skipped calls get synthetic
    // results. This is a protocol requirement, not a design choice.
    // ────────────────────────────────────────────────────────────────────────

    // Build ToolResultMessages for all planned calls.
    const toolResults: ToolResultMessage[] = executions.map(ex => {
      switch (ex.status) {
        case 'success':
        case 'runtime_failure':
          return realResult(
            ex.callId,
            ex.result?.content ?? (ex.error ?? 'Tool returned no content'),
            ex.status === 'runtime_failure',
          )
        case 'cancelled':
          return syntheticResult(ex.callId, 'Cancelled: AbortSignal fired before this call ran.')
        case 'skipped':
          return syntheticResult(ex.callId, 'Skipped: steering interrupted before this call ran.')
        case 'policy_denied':
          return syntheticResult(ex.callId, `Denied by policy: ${ex.error ?? 'no reason given'}.`)
        case 'timeout':
          return syntheticResult(ex.callId, `Timeout: tool did not return within the time budget.`)
      }
    })

    const plannedCallIds  = plan.map(p => p.callId)
    const executedCallIds = executions.filter(e => e.status === 'success' || e.status === 'runtime_failure').map(e => e.callId)

    let outcome: TurnRecord['outcome']
    if (interruptReason === 'abort') {
      outcome = 'aborted'
    } else if (interruptReason === 'steering') {
      outcome = 'interrupted'
    } else {
      outcome = 'answered'
    }

    // Append to conversation atomically (AssistantMessage + all ToolResultMessages).
    conversation.push(response)
    for (const tr of toolResults) conversation.push(tr)
    if (interruptReason === 'steering') {
      for (const msg of steeringMessages) conversation.push(msg)
    }

    const record: TurnRecord = {
      turnId,
      userInput:     null,
      modelRequest:  { system: context.system, messages: context.messages, tools: config.tools.tools() },
      modelResponse: response,
      plan,
      executions,
      outcome,
      ...(interruptReason ? {
        interrupted: {
          plannedCalls:  plannedCallIds,
          executedCalls: executedCallIds,
          reason:        interruptReason,
        },
      } : {}),
      durationMs:  Date.now() - t0,
      tokenUsage:  usage,
      contextUsed: context.contextUsed,
    }

    records.push(record)
    await emit({ type: 'turn_end', record })

    // Auto-stop: skip follow-up LLM call when all tools succeeded and model
    // produced no text content (tool results are already visible via tool_end).
    if (config.autoStop && !interruptReason) {
      const allOk  = executions.every(e => e.status === 'success')
      const noText = !response.content?.trim()
      if (allOk && noText) {
        return records
      }
    }

    if (interruptReason === 'abort') {
      const failure: Failure = { kind: 'abort', message: 'AbortSignal fired during tool execution' }
      await emit({ type: 'error', failure })
      return records
    }

    // If steering interrupted, loop continues — getContext() called at next iteration start.
  }
}
