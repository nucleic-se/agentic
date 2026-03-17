/**
 * CodingAgent integration tests.
 *
 * Tests the full agent lifecycle with mock providers — verifies that
 * summarization, fact extraction, context broker, and the kernel work
 * together correctly across multiple prompt() calls.
 */

import { describe, it, expect, vi } from 'vitest'
import { CodingAgent } from './CodingAgent.js'
import type { AgentConfig } from './config.js'
import type {
  Message, TurnRequest, TurnResponse, ILLMProvider,
  IModelRouter, ModelTier, ToolDefinition, TokenUsage,
  StructuredRequest, StructuredResponse,
} from '../../contracts/llm.js'
import type { IToolRuntime } from '../../contracts/tool-runtime.js'
import type { AgentEvent, TurnRecord } from '../../contracts/agent.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 }

const TOOLS: ToolDefinition[] = [{
  name: 'fs_read',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}]

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

/**
 * Creates a mock router with separate fast and balanced providers.
 * Fast provider is used for summarization/fact extraction (structured()).
 * Balanced provider is used for the main agent loop (turn()).
 */
function makeMockRouter(opts: {
  balancedResponses: TurnResponse[]
  structuredResults?: unknown[]
}): IModelRouter {
  let turnIdx = 0
  let structIdx = 0

  const balanced: ILLMProvider = {
    async turn(): Promise<TurnResponse> {
      const r = opts.balancedResponses[turnIdx++]
      if (!r) throw new Error(`No balanced response at index ${turnIdx - 1}`)
      return r
    },
    async structured() { throw new Error('balanced should not call structured') },
    async embed() { return [] },
  }

  const fast: ILLMProvider = {
    async turn() { throw new Error('fast should not call turn') },
    async structured<T>(req: StructuredRequest): Promise<StructuredResponse<T>> {
      const result = opts.structuredResults?.[structIdx++]
      if (result === undefined) {
        // Default: return a plausible summary-shaped object
        return {
          value: {
            userIntent: 'test intent',
            toolsUsed: ['fs_read'],
            filesRead: ['test.txt'],
            filesModified: [],
            keyFindings: ['found something'],
            unresolvedItems: [],
            // fact extractor shape
            facts: [{ key: 'test_key', value: 'test_value', confidence: 0.9 }],
          } as T,
          usage: ZERO_USAGE,
        }
      }
      return { value: result as T, usage: ZERO_USAGE }
    },
    async embed() { return [] },
  }

  return {
    select: (tier: ModelTier) => tier === 'fast' ? fast : balanced,
  }
}

function makeTools(): IToolRuntime {
  return {
    tools: () => TOOLS,
    async call(name, args) {
      return { ok: true, content: `content of ${(args as { path?: string }).path ?? 'unknown'}` }
    },
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('CodingAgent', () => {
  it('stores summaries after prompt() returns (flush)', async () => {
    const router = makeMockRouter({
      balancedResponses: [
        toolResponse([{ id: 'c1', name: 'fs_read', args: { path: 'hello.txt' } }]),
        textResponse('The file says hello.'),
      ],
    })

    const agent = new CodingAgent({
      router,
      tools: makeTools(),
      systemPrompt: 'Test agent.',
    })

    const records = await agent.prompt('read hello.txt')

    // After prompt returns, pending tasks (summarization) should be flushed.
    // We can verify by checking execution history has records.
    expect(records.length).toBeGreaterThanOrEqual(1)
    expect(agent.getExecutionHistory().length).toBeGreaterThanOrEqual(1)
  })

  it('includes turn_summary in contextUsed on second prompt', async () => {
    const router = makeMockRouter({
      balancedResponses: [
        // Prompt 1: tool call + response
        toolResponse([{ id: 'c1', name: 'fs_read', args: { path: 'hello.txt' } }]),
        textResponse('File says hello.'),
        // Prompt 2: just a text response
        textResponse('Sure, hello.txt contained a greeting.'),
      ],
    })

    const agent = new CodingAgent({
      router,
      tools: makeTools(),
      systemPrompt: 'Test agent.',
    })

    // Prompt 1: should trigger summarization
    await agent.prompt('read hello.txt')

    // Prompt 2: summaries from prompt 1 should be in context
    const turn2Events: AgentEvent[] = []
    const records2 = await agent.prompt('what did hello.txt say?', (e) => {
      turn2Events.push(e)
    })

    // Find contextUsed from the turn_end events of prompt 2
    const turnEnds = turn2Events.filter(e => e.type === 'turn_end') as Array<{ type: 'turn_end'; record: TurnRecord }>
    expect(turnEnds.length).toBeGreaterThan(0)

    const allSources = turnEnds.flatMap(te =>
      (te.record.contextUsed ?? []).map(c => c.source)
    )

    expect(allSources).toContain('turn_summary')
  })

  it('includes facts in contextUsed on second prompt', async () => {
    const router = makeMockRouter({
      balancedResponses: [
        // Prompt 1
        toolResponse([{ id: 'c1', name: 'fs_read', args: { path: 'config.json' } }]),
        textResponse('Config loaded.'),
        // Prompt 2
        textResponse('The config uses port 3000.'),
      ],
    })

    const agent = new CodingAgent({
      router,
      tools: makeTools(),
      systemPrompt: 'Test agent.',
    })

    await agent.prompt('read config.json')

    const turn2Events: AgentEvent[] = []
    await agent.prompt('what port does it use?', (e) => {
      turn2Events.push(e)
    })

    const turnEnds = turn2Events.filter(e => e.type === 'turn_end') as Array<{ type: 'turn_end'; record: TurnRecord }>
    const allSources = turnEnds.flatMap(te =>
      (te.record.contextUsed ?? []).map(c => c.source)
    )

    expect(allSources).toContain('fact')
  })

  it('includes session_file_tracker after tool calls', async () => {
    const router = makeMockRouter({
      balancedResponses: [
        // Prompt 1
        toolResponse([{ id: 'c1', name: 'fs_read', args: { path: 'src/main.ts' } }]),
        textResponse('Read it.'),
        // Prompt 2
        textResponse('Yes, main.ts was read.'),
      ],
    })

    const agent = new CodingAgent({
      router,
      tools: makeTools(),
      systemPrompt: 'Test agent.',
    })

    await agent.prompt('read src/main.ts')

    const turn2Events: AgentEvent[] = []
    await agent.prompt('what files have I read?', (e) => {
      turn2Events.push(e)
    })

    const turnEnds = turn2Events.filter(e => e.type === 'turn_end') as Array<{ type: 'turn_end'; record: TurnRecord }>
    const allSources = turnEnds.flatMap(te =>
      (te.record.contextUsed ?? []).map(c => c.source)
    )

    expect(allSources).toContain('session_file_tracker')
  })

  it('clearSession resets all state', async () => {
    const router = makeMockRouter({
      balancedResponses: [
        toolResponse([{ id: 'c1', name: 'fs_read', args: { path: 'a.txt' } }]),
        textResponse('Done.'),
        // After clear — fresh prompt
        textResponse('Fresh start.'),
      ],
    })

    const agent = new CodingAgent({
      router,
      tools: makeTools(),
      systemPrompt: 'Test agent.',
    })

    await agent.prompt('read a.txt')
    expect(agent.getExecutionHistory().length).toBeGreaterThan(0)
    expect(agent.getConversation().length).toBeGreaterThan(0)

    agent.clearSession()

    expect(agent.getExecutionHistory()).toHaveLength(0)
    expect(agent.getConversation()).toHaveLength(0)

    // Fresh prompt should work with no turn_summary sources
    const events: AgentEvent[] = []
    await agent.prompt('fresh start', (e) => { events.push(e) })

    const turnEnds = events.filter(e => e.type === 'turn_end') as Array<{ type: 'turn_end'; record: TurnRecord }>
    const allSources = turnEnds.flatMap(te =>
      (te.record.contextUsed ?? []).map(c => c.source)
    )

    expect(allSources).not.toContain('turn_summary')
    expect(allSources).not.toContain('session_file_tracker')
  })

  it('handles summarization failure gracefully', async () => {
    let structCallCount = 0
    const router: IModelRouter = {
      select: (tier: ModelTier) => {
        if (tier === 'fast') {
          return {
            async turn() { throw new Error('no') },
            async structured() {
              structCallCount++
              throw new Error('structured output failed')
            },
            async embed() { return [] },
          }
        }
        let i = 0
        const responses = [
          toolResponse([{ id: 'c1', name: 'fs_read', args: { path: 'x.txt' } }]),
          textResponse('ok'),
          textResponse('still works'),
        ]
        return {
          async turn() { return responses[i++]! },
          async structured() { throw new Error('no') },
          async embed() { return [] },
        }
      },
    }

    const agent = new CodingAgent({
      router,
      tools: makeTools(),
      systemPrompt: 'Test agent.',
    })

    // Should not throw even if summarization fails
    await agent.prompt('read x.txt')

    // Structured was called (summarize + extract attempted)
    expect(structCallCount).toBeGreaterThan(0)

    // Agent still works for prompt 2
    const records2 = await agent.prompt('still here?')
    expect(records2.length).toBeGreaterThan(0)
  })
})
