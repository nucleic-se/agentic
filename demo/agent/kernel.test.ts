/**
 * Kernel behavioural tests.
 *
 * These test the runKernel() function with mock providers and tool runtimes.
 * No real LLM calls. No network. Pure protocol correctness.
 */

import { describe, it, expect, vi } from 'vitest'
import { runKernel } from './kernel.js'
import type { AgentConfig } from './config.js'
import type { Message, AssistantMessage, TurnRequest, TurnResponse, ILLMProvider, IModelRouter, ToolDefinition, TokenUsage } from '../../contracts/llm.js'
import type { IToolRuntime, ToolCallResult } from '../../contracts/tool-runtime.js'
import type { AgentEvent, AgentEventSink, TurnRecord } from '../../contracts/agent.js'
import type { IToolPolicy, ToolPolicyDecision } from '../../contracts/IToolPolicy.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 }

const DUMMY_TOOLS: ToolDefinition[] = [{
  name: 'echo',
  description: 'Echo input',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
}]

function makeProvider(responses: TurnResponse[]): ILLMProvider {
  let i = 0
  return {
    async turn(_req: TurnRequest): Promise<TurnResponse> {
      const r = responses[i++]
      if (!r) throw new Error(`Mock provider: no response at index ${i - 1}`)
      return r
    },
    async structured() { throw new Error('not implemented') },
    async embed() { return [] },
  }
}

function makeRouter(provider: ILLMProvider): IModelRouter {
  return { select: () => provider }
}

function makeTools(handler?: (name: string, args: Record<string, unknown>) => ToolCallResult): IToolRuntime {
  return {
    tools: () => DUMMY_TOOLS,
    async call(name, args) {
      if (handler) return handler(name, args)
      return { ok: true, content: `echo: ${(args as { text?: string }).text ?? ''}` }
    },
  }
}

function textResponse(content: string): TurnResponse {
  return {
    message: { role: 'assistant', content },
    stopReason: 'end_turn',
    usage: ZERO_USAGE,
  }
}

function toolResponse(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>, content = ''): TurnResponse {
  return {
    message: {
      role: 'assistant',
      content,
      toolCalls: calls.map(c => ({ id: c.id, name: c.name, args: c.args })),
    },
    stopReason: 'tool_use',
    usage: ZERO_USAGE,
  }
}

function staticContext(system = 'test') {
  return (messages: Message[]) => ({
    system,
    messages,
  })
}

function collectEvents(): { events: AgentEvent[]; sink: AgentEventSink } {
  const events: AgentEvent[] = []
  return { events, sink: (e: AgentEvent) => { events.push(e) } }
}

function minimalConfig(overrides: Partial<AgentConfig> & { router: IModelRouter; tools: IToolRuntime }): AgentConfig {
  return { ...overrides }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('runKernel', () => {
  // ── Basic text response ──────────────────────────────────────────────────

  it('produces a single TurnRecord for a text-only response', async () => {
    const provider = makeProvider([textResponse('Hello!')])
    const tools = makeTools()
    const conversation: Message[] = [{ role: 'user', content: 'hi' }]
    const { events, sink } = collectEvents()

    const records = await runKernel(
      conversation,
      minimalConfig({ router: makeRouter(provider), tools }),
      () => ({ system: 'sys', messages: conversation }),
      sink,
    )

    expect(records).toHaveLength(1)
    expect(records[0]!.outcome).toBe('answered')
    expect(records[0]!.executions).toHaveLength(0)
    expect(records[0]!.plan).toHaveLength(0)
    expect(records[0]!.modelResponse.content).toBe('Hello!')
  })

  // ── Tool call → reconcile ────────────────────────────────────────────────

  it('executes tool calls and produces correct TurnRecord', async () => {
    const provider = makeProvider([
      toolResponse([{ id: 'c1', name: 'echo', args: { text: 'test' } }]),
      textResponse('Done.'),
    ])
    const tools = makeTools()
    const conversation: Message[] = [{ role: 'user', content: 'echo test' }]
    const { events, sink } = collectEvents()

    const records = await runKernel(
      conversation,
      minimalConfig({ router: makeRouter(provider), tools }),
      () => ({ system: 'sys', messages: conversation }),
      sink,
    )

    // Two turns: tool call + text follow-up
    expect(records).toHaveLength(2)

    const toolTurn = records[0]!
    expect(toolTurn.outcome).toBe('answered')
    expect(toolTurn.plan).toHaveLength(1)
    expect(toolTurn.plan[0]!.name).toBe('echo')
    expect(toolTurn.executions).toHaveLength(1)
    expect(toolTurn.executions[0]!.status).toBe('success')
    expect(toolTurn.executions[0]!.result?.content).toContain('echo: test')

    const textTurn = records[1]!
    expect(textTurn.outcome).toBe('answered')
    expect(textTurn.modelResponse.content).toBe('Done.')
  })

  // ── Event ordering ───────────────────────────────────────────────────────

  it('emits events in correct order for a tool-call turn', async () => {
    const provider = makeProvider([
      toolResponse([{ id: 'c1', name: 'echo', args: { text: 'hi' } }]),
      textResponse('ok'),
    ])
    const tools = makeTools()
    const conversation: Message[] = [{ role: 'user', content: 'go' }]
    const { events, sink } = collectEvents()

    await runKernel(
      conversation,
      minimalConfig({ router: makeRouter(provider), tools }),
      () => ({ system: 'sys', messages: conversation }),
      sink,
    )

    const types = events.map(e => e.type)
    // Turn 1: tool call
    expect(types[0]).toBe('turn_start')
    expect(types[1]).toBe('message_end')
    expect(types[2]).toBe('tool_start')
    expect(types[3]).toBe('tool_end')
    expect(types[4]).toBe('turn_end')
    // Turn 2: text response
    expect(types[5]).toBe('turn_start')
    expect(types[6]).toBe('message_end')
    expect(types[7]).toBe('turn_end')
  })

  // ── Multiple tool calls in one response ──────────────────────────────────

  it('handles multiple tool calls in a single response', async () => {
    const provider = makeProvider([
      toolResponse([
        { id: 'c1', name: 'echo', args: { text: 'a' } },
        { id: 'c2', name: 'echo', args: { text: 'b' } },
      ]),
      textResponse('Both done.'),
    ])
    const tools = makeTools()
    const conversation: Message[] = [{ role: 'user', content: 'two calls' }]
    const { sink } = collectEvents()

    const records = await runKernel(
      conversation,
      minimalConfig({ router: makeRouter(provider), tools }),
      () => ({ system: 'sys', messages: conversation }),
      sink,
    )

    expect(records[0]!.executions).toHaveLength(2)
    expect(records[0]!.executions[0]!.result?.content).toContain('echo: a')
    expect(records[0]!.executions[1]!.result?.content).toContain('echo: b')
  })

  // ── Duplicate tool call dedup ────────────────────────────────────────────

  it('deduplicates tool calls with the same callId', async () => {
    const provider = makeProvider([
      toolResponse([
        { id: 'dup', name: 'echo', args: { text: 'first' } },
        { id: 'dup', name: 'echo', args: { text: 'second' } },
      ]),
      textResponse('ok'),
    ])
    const tools = makeTools()
    const conversation: Message[] = [{ role: 'user', content: 'test' }]
    const { sink } = collectEvents()

    const records = await runKernel(
      conversation,
      minimalConfig({ router: makeRouter(provider), tools }),
      () => ({ system: 'sys', messages: conversation }),
      sink,
    )

    // Only the first call with id 'dup' should execute
    expect(records[0]!.executions).toHaveLength(1)
    expect(records[0]!.executions[0]!.result?.content).toContain('echo: first')
  })

  // ── Policy deny ──────────────────────────────────────────────────────────

  it('marks tool calls as policy_denied when policy denies them', async () => {
    const provider = makeProvider([
      toolResponse([{ id: 'c1', name: 'echo', args: { text: 'blocked' } }]),
      textResponse('denied'),
    ])
    const tools = makeTools()
    const denyPolicy: IToolPolicy = {
      async evaluate() { return { kind: 'deny', reason: 'test deny' } },
    }
    const conversation: Message[] = [{ role: 'user', content: 'try' }]
    const { events, sink } = collectEvents()

    const records = await runKernel(
      conversation,
      minimalConfig({ router: makeRouter(provider), tools, policy: denyPolicy }),
      () => ({ system: 'sys', messages: conversation }),
      sink,
    )

    expect(records[0]!.executions).toHaveLength(1)
    expect(records[0]!.executions[0]!.status).toBe('policy_denied')
    expect(records[0]!.executions[0]!.error).toBe('test deny')

    // tool_end is emitted for denied calls
    const toolEnds = events.filter(e => e.type === 'tool_end')
    expect(toolEnds).toHaveLength(1)
  })

  // ── Policy confirm → deny (no confirmToolCall hook) ──────────────────────

  it('denies confirmation when no confirmToolCall hook is provided', async () => {
    const provider = makeProvider([
      toolResponse([{ id: 'c1', name: 'echo', args: { text: 'confirm me' } }]),
      textResponse('denied'),
    ])
    const tools = makeTools()
    const confirmPolicy: IToolPolicy = {
      async evaluate() { return { kind: 'confirm', reason: 'needs confirmation' } },
    }
    const conversation: Message[] = [{ role: 'user', content: 'try' }]
    const { sink } = collectEvents()

    const records = await runKernel(
      conversation,
      minimalConfig({ router: makeRouter(provider), tools, policy: confirmPolicy }),
      () => ({ system: 'sys', messages: conversation }),
      sink,
    )

    expect(records[0]!.executions[0]!.status).toBe('policy_denied')
    expect(records[0]!.executions[0]!.error).toContain('Confirmation denied')
  })

  // ── Policy confirm → allow ───────────────────────────────────────────────

  it('executes tool call when confirmToolCall returns true', async () => {
    const provider = makeProvider([
      toolResponse([{ id: 'c1', name: 'echo', args: { text: 'allowed' } }]),
      textResponse('ok'),
    ])
    const tools = makeTools()
    const confirmPolicy: IToolPolicy = {
      async evaluate() { return { kind: 'confirm', reason: 'needs confirmation' } },
    }
    const confirmHook = vi.fn().mockResolvedValue(true)
    const conversation: Message[] = [{ role: 'user', content: 'try' }]
    const { sink } = collectEvents()

    const records = await runKernel(
      conversation,
      minimalConfig({
        router: makeRouter(provider),
        tools,
        policy: confirmPolicy,
        confirmToolCall: confirmHook,
      }),
      () => ({ system: 'sys', messages: conversation }),
      sink,
    )

    expect(confirmHook).toHaveBeenCalledOnce()
    expect(records[0]!.executions[0]!.status).toBe('success')
  })

  // ── Policy rewrite ───────────────────────────────────────────────────────

  it('rewrites tool args when policy returns rewrite decision', async () => {
    const provider = makeProvider([
      toolResponse([{ id: 'c1', name: 'echo', args: { text: 'original' } }]),
      textResponse('ok'),
    ])
    const callArgs = vi.fn<[string, Record<string, unknown>], ToolCallResult>()
      .mockReturnValue({ ok: true, content: 'rewritten' })
    const tools = makeTools((name, args) => callArgs(name, args))
    const rewritePolicy: IToolPolicy = {
      async evaluate() {
        return { kind: 'rewrite', args: { text: 'rewritten-by-policy' } }
      },
    }
    const conversation: Message[] = [{ role: 'user', content: 'try' }]
    const { sink } = collectEvents()

    await runKernel(
      conversation,
      minimalConfig({ router: makeRouter(provider), tools, policy: rewritePolicy }),
      () => ({ system: 'sys', messages: conversation }),
      sink,
    )

    expect(callArgs).toHaveBeenCalledWith('echo', { text: 'rewritten-by-policy' })
  })

  // ── Abort mid-execution ──────────────────────────────────────────────────

  it('cancels remaining calls when abort signal fires', async () => {
    const ac = new AbortController()
    const provider = makeProvider([
      toolResponse([
        { id: 'c1', name: 'echo', args: { text: 'first' } },
        { id: 'c2', name: 'echo', args: { text: 'second' } },
      ]),
    ])
    // Abort after first tool call
    let callCount = 0
    const tools = makeTools((name, args) => {
      callCount++
      if (callCount === 1) ac.abort()
      return { ok: true, content: `call ${callCount}` }
    })
    const conversation: Message[] = [{ role: 'user', content: 'abort test' }]
    const { events, sink } = collectEvents()

    const records = await runKernel(
      conversation,
      minimalConfig({ router: makeRouter(provider), tools }),
      () => ({ system: 'sys', messages: conversation }),
      sink,
      ac.signal,
    )

    expect(records).toHaveLength(1)
    expect(records[0]!.outcome).toBe('aborted')
    expect(records[0]!.executions[0]!.status).toBe('success')
    expect(records[0]!.executions[1]!.status).toBe('cancelled')
    expect(records[0]!.interrupted).toBeDefined()
    expect(records[0]!.interrupted!.reason).toBe('abort')

    // Error event for abort
    const errorEvents = events.filter(e => e.type === 'error')
    expect(errorEvents).toHaveLength(1)
  })

  // ── Max turns ────────────────────────────────────────────────────────────

  it('stops with max_turns_exceeded after reaching turn limit', async () => {
    // Model keeps calling tools forever
    const provider = makeProvider(
      Array.from({ length: 10 }, () =>
        toolResponse([{ id: `c${Math.random()}`, name: 'echo', args: { text: 'loop' } }])
      )
    )
    const tools = makeTools()
    const conversation: Message[] = [{ role: 'user', content: 'loop' }]
    const { events, sink } = collectEvents()

    const records = await runKernel(
      conversation,
      minimalConfig({ router: makeRouter(provider), tools, maxTurns: 3 }),
      () => ({ system: 'sys', messages: conversation }),
      sink,
    )

    expect(records).toHaveLength(3)

    const errorEvents = events.filter(e => e.type === 'error')
    expect(errorEvents).toHaveLength(1)
    const err = errorEvents[0] as { type: 'error'; failure: { kind: string } }
    expect(err.failure.kind).toBe('max_turns_exceeded')
  })

  // ── autoStop ─────────────────────────────────────────────────────────────

  it('returns without follow-up LLM call when autoStop is enabled and tools succeed', async () => {
    const turnFn = vi.fn<[TurnRequest], Promise<TurnResponse>>()
    turnFn.mockResolvedValueOnce(
      toolResponse([{ id: 'c1', name: 'echo', args: { text: 'hello' } }])
    )
    // Should NOT be called
    turnFn.mockResolvedValueOnce(textResponse('should not reach'))

    const provider: ILLMProvider = {
      turn: turnFn,
      async structured() { throw new Error('not implemented') },
      async embed() { return [] },
    }
    const tools = makeTools()
    const conversation: Message[] = [{ role: 'user', content: 'go' }]
    const { sink } = collectEvents()

    const records = await runKernel(
      conversation,
      minimalConfig({ router: makeRouter(provider), tools, autoStop: true }),
      () => ({ system: 'sys', messages: conversation }),
      sink,
    )

    expect(records).toHaveLength(1)
    expect(records[0]!.outcome).toBe('answered')
    expect(turnFn).toHaveBeenCalledTimes(1)
  })

  it('does NOT autoStop when model produces text alongside tool calls', async () => {
    const turnFn = vi.fn<[TurnRequest], Promise<TurnResponse>>()
    turnFn.mockResolvedValueOnce(
      toolResponse([{ id: 'c1', name: 'echo', args: { text: 'hi' } }], 'Some text')
    )
    turnFn.mockResolvedValueOnce(textResponse('follow-up'))

    const provider: ILLMProvider = {
      turn: turnFn,
      async structured() { throw new Error('not implemented') },
      async embed() { return [] },
    }
    const tools = makeTools()
    const conversation: Message[] = [{ role: 'user', content: 'go' }]
    const { sink } = collectEvents()

    const records = await runKernel(
      conversation,
      minimalConfig({ router: makeRouter(provider), tools, autoStop: true }),
      () => ({ system: 'sys', messages: conversation }),
      sink,
    )

    expect(records).toHaveLength(2)
    expect(turnFn).toHaveBeenCalledTimes(2)
  })

  it('does NOT autoStop when a tool fails', async () => {
    const turnFn = vi.fn<[TurnRequest], Promise<TurnResponse>>()
    turnFn.mockResolvedValueOnce(
      toolResponse([{ id: 'c1', name: 'echo', args: { text: 'fail' } }])
    )
    turnFn.mockResolvedValueOnce(textResponse('handling error'))

    const provider: ILLMProvider = {
      turn: turnFn,
      async structured() { throw new Error('not implemented') },
      async embed() { return [] },
    }
    const tools = makeTools(() => ({ ok: false, content: 'tool error' }))
    const conversation: Message[] = [{ role: 'user', content: 'go' }]
    const { sink } = collectEvents()

    const records = await runKernel(
      conversation,
      minimalConfig({ router: makeRouter(provider), tools, autoStop: true }),
      () => ({ system: 'sys', messages: conversation }),
      sink,
    )

    expect(records).toHaveLength(2)
    expect(turnFn).toHaveBeenCalledTimes(2)
  })

  // ── modelRequest fidelity ────────────────────────────────────────────────

  it('records the actual TurnRequest in modelRequest (post-hook)', async () => {
    const provider = makeProvider([textResponse('hi')])
    const tools = makeTools()
    const conversation: Message[] = [{ role: 'user', content: 'test' }]
    const { sink } = collectEvents()

    const hookMessages: Message[] = [
      { role: 'user', content: 'test' },
      { role: 'user', content: 'injected by hook' },
    ]
    const onBeforeLlmCall = vi.fn().mockResolvedValue(hookMessages)

    const records = await runKernel(
      conversation,
      minimalConfig({ router: makeRouter(provider), tools, onBeforeLlmCall }),
      () => ({ system: 'sys', messages: conversation }),
      sink,
    )

    // modelRequest should contain the hook-transformed messages
    expect(records[0]!.modelRequest.messages).toEqual(hookMessages)
  })

  // ── Tool result truncation ───────────────────────────────────────────────

  it('truncates tool results exceeding 4000 chars', async () => {
    const longContent = 'x'.repeat(5000)
    const provider = makeProvider([
      toolResponse([{ id: 'c1', name: 'echo', args: { text: 'big' } }]),
      textResponse('ok'),
    ])
    const tools = makeTools(() => ({ ok: true, content: longContent }))
    const conversation: Message[] = [{ role: 'user', content: 'big' }]
    const { sink } = collectEvents()

    const records = await runKernel(
      conversation,
      minimalConfig({ router: makeRouter(provider), tools }),
      () => ({ system: 'sys', messages: conversation }),
      sink,
    )

    // The conversation should have a truncated tool result
    const toolResult = conversation.find(m => m.role === 'tool_result')
    expect(toolResult).toBeDefined()
    expect((toolResult as any).content.length).toBeLessThan(longContent.length)
    expect((toolResult as any).content).toContain('[truncated')
  })

  // ── Tool runtime failure ─────────────────────────────────────────────────

  it('handles tool runtime errors gracefully', async () => {
    const provider = makeProvider([
      toolResponse([{ id: 'c1', name: 'echo', args: { text: 'crash' } }]),
      textResponse('recovered'),
    ])
    const tools = makeTools(() => { throw new Error('tool crashed') })
    const conversation: Message[] = [{ role: 'user', content: 'crash' }]
    const { sink } = collectEvents()

    const records = await runKernel(
      conversation,
      minimalConfig({ router: makeRouter(provider), tools }),
      () => ({ system: 'sys', messages: conversation }),
      sink,
    )

    expect(records[0]!.executions[0]!.status).toBe('runtime_failure')
    expect(records[0]!.executions[0]!.error).toContain('tool crashed')
  })

  // ── LLM transport error ──────────────────────────────────────────────────

  it('produces a failed TurnRecord when the provider throws', async () => {
    const provider: ILLMProvider = {
      async turn() { throw new Error('network timeout') },
      async structured() { throw new Error('not implemented') },
      async embed() { return [] },
    }
    const tools = makeTools()
    const conversation: Message[] = [{ role: 'user', content: 'test' }]
    const { events, sink } = collectEvents()

    const records = await runKernel(
      conversation,
      minimalConfig({ router: makeRouter(provider), tools }),
      () => ({ system: 'sys', messages: conversation }),
      sink,
    )

    expect(records).toHaveLength(1)
    expect(records[0]!.outcome).toBe('failed')
    expect(records[0]!.failure?.kind).toBe('llm_transport_error')
    expect(records[0]!.failure?.message).toContain('network timeout')

    // Both turn_end and error events emitted
    expect(events.some(e => e.type === 'turn_end')).toBe(true)
    expect(events.some(e => e.type === 'error')).toBe(true)
  })

  // ── max_tokens stop ──────────────────────────────────────────────────────

  it('produces a partial TurnRecord when model stops at max_tokens', async () => {
    const provider = makeProvider([{
      message: { role: 'assistant', content: 'truncated...' },
      stopReason: 'max_tokens',
      usage: ZERO_USAGE,
    }])
    const tools = makeTools()
    const conversation: Message[] = [{ role: 'user', content: 'long' }]
    const { events, sink } = collectEvents()

    const records = await runKernel(
      conversation,
      minimalConfig({ router: makeRouter(provider), tools }),
      () => ({ system: 'sys', messages: conversation }),
      sink,
    )

    expect(records).toHaveLength(1)
    expect(records[0]!.outcome).toBe('partial')
    expect(records[0]!.failure?.kind).toBe('max_tokens_stop')
  })

  // ── Context error ────────────────────────────────────────────────────────

  it('emits context_error and returns empty when getContext throws', async () => {
    const provider = makeProvider([textResponse('unreachable')])
    const tools = makeTools()
    const conversation: Message[] = [{ role: 'user', content: 'test' }]
    const { events, sink } = collectEvents()

    const records = await runKernel(
      conversation,
      minimalConfig({ router: makeRouter(provider), tools }),
      () => { throw new Error('broker failed') },
      sink,
    )

    expect(records).toHaveLength(0)
    const errorEvents = events.filter(e => e.type === 'error')
    expect(errorEvents).toHaveLength(1)
    const err = errorEvents[0] as { type: 'error'; failure: { kind: string } }
    expect(err.failure.kind).toBe('context_error')
  })

  // ── Conversation mutation ────────────────────────────────────────────────

  it('appends assistant response and tool results to conversation', async () => {
    const provider = makeProvider([
      toolResponse([{ id: 'c1', name: 'echo', args: { text: 'hi' } }]),
      textResponse('done'),
    ])
    const tools = makeTools()
    const conversation: Message[] = [{ role: 'user', content: 'start' }]
    const { sink } = collectEvents()

    await runKernel(
      conversation,
      minimalConfig({ router: makeRouter(provider), tools }),
      () => ({ system: 'sys', messages: conversation }),
      sink,
    )

    // Original user + assistant (tool_use) + tool_result + assistant (text)
    expect(conversation).toHaveLength(4)
    expect(conversation[0]!.role).toBe('user')
    expect(conversation[1]!.role).toBe('assistant')
    expect(conversation[2]!.role).toBe('tool_result')
    expect(conversation[3]!.role).toBe('assistant')
  })

  // ── Steering interruption ────────────────────────────────────────────────

  it('handles steering interruption mid-execution', async () => {
    const provider = makeProvider([
      toolResponse([
        { id: 'c1', name: 'echo', args: { text: 'first' } },
        { id: 'c2', name: 'echo', args: { text: 'second' } },
      ]),
      textResponse('after steering'),
    ])
    let callCount = 0
    const tools = makeTools(() => {
      callCount++
      return { ok: true, content: `result ${callCount}` }
    })
    const conversation: Message[] = [{ role: 'user', content: 'steer' }]
    const { sink } = collectEvents()

    // Inject a steering message after the first tool call
    let steerCount = 0
    const getSteeringMessages = async () => {
      steerCount++
      if (steerCount === 1) {
        return [{ role: 'user' as const, content: 'steering override' }]
      }
      return []
    }

    const records = await runKernel(
      conversation,
      minimalConfig({ router: makeRouter(provider), tools, getSteeringMessages }),
      () => ({ system: 'sys', messages: conversation }),
      sink,
    )

    expect(records[0]!.outcome).toBe('interrupted')
    expect(records[0]!.executions[0]!.status).toBe('success')
    expect(records[0]!.executions[1]!.status).toBe('skipped')
    expect(records[0]!.interrupted?.reason).toBe('steering')
  })

  // ── beforeToolCall hook: skip ────────────────────────────────────────────

  it('skips tool calls when beforeToolCall returns skip', async () => {
    const provider = makeProvider([
      toolResponse([{ id: 'c1', name: 'echo', args: { text: 'skip me' } }]),
      textResponse('skipped'),
    ])
    const tools = makeTools()
    const conversation: Message[] = [{ role: 'user', content: 'skip' }]
    const { sink } = collectEvents()

    const records = await runKernel(
      conversation,
      minimalConfig({
        router: makeRouter(provider),
        tools,
        beforeToolCall: async () => ({ action: 'skip' as const, reason: 'hook skip' }),
      }),
      () => ({ system: 'sys', messages: conversation }),
      sink,
    )

    expect(records[0]!.executions[0]!.status).toBe('skipped')
  })

  // ── streamTurn ───────────────────────────────────────────────────────────

  it('uses streamTurn when available on the provider', async () => {
    const deltas: string[] = []
    const provider: ILLMProvider = {
      async turn() { throw new Error('should not be called') },
      async streamTurn(req, onDelta) {
        onDelta('Hello ')
        onDelta('world')
        return textResponse('Hello world')
      },
      async structured() { throw new Error('not implemented') },
      async embed() { return [] },
    }
    const tools = makeTools()
    const conversation: Message[] = [{ role: 'user', content: 'stream' }]
    const { events, sink } = collectEvents()

    const records = await runKernel(
      conversation,
      minimalConfig({ router: makeRouter(provider), tools }),
      () => ({ system: 'sys', messages: conversation }),
      sink,
    )

    expect(records).toHaveLength(1)
    expect(records[0]!.modelResponse.content).toBe('Hello world')

    // message_delta events should be emitted
    const deltaEvents = events.filter(e => e.type === 'message_delta')
    expect(deltaEvents).toHaveLength(2)
  })
})
