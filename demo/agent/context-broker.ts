/**
 * ContextBroker — session-aware context assembly.
 *
 * Two responsibilities kept separate:
 *   1. Selection — score candidates, apply tier rules, pick what fits
 *   2. Rendering — encode into PromptSection[] and pass to IPromptEngine
 *
 * IPromptEngine is the safety net (hard budget cut). The broker adds the
 * intelligence to decide which things are worth including first.
 *
 * Phase C covers: system prompt, session file tracker, and turn summaries.
 * Phase E adds:   scratchpad and facts from FactStore.
 */

import { estimateTokens }         from '../../utils.js'
import { PromptEngine }           from '../../runtime/PromptEngine.js'
import type { IPromptEngine, PromptSection, PromptComposeResult } from '../../contracts/IPromptEngine.js'
import type { Message }           from '../../contracts/llm.js'
import type { ContextCandidate, ContextScore }  from '../../contracts/agent.js'
import { formatSummary, truncateSummary }       from './turn-summarizer.js'
import type { TurnSummary }       from './turn-summarizer.js'
import type { SessionFileTracker } from './session-file-tracker.js'
import type { FactStore }         from './fact-store.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AssembledContext {
  /** Rendered by IPromptEngine: system prompt, summaries, file tracker. */
  system:     string
  /** Broker-selected tail of the raw conversation. NOT the full history. */
  messages:   Message[]
  /** Selection metadata for TurnRecord.contextUsed. */
  selections: ContextCandidate[]
  /** IPromptEngine stats: included/excluded/totalTokens. */
  stats:      PromptComposeResult
}

export interface AgentContextQuery {
  userInput:     string
  /** Full raw conversation. Broker selects its own tail window. */
  conversation:  Message[]
  /** Summaries for older turns; may have gaps (trivial turns may lack summaries). */
  turnSummaries: TurnSummary[]
  tokenBudget:   number
}

export interface ContextBroker {
  assemble(query: AgentContextQuery): Promise<AssembledContext>
}

// ── Scoring helpers ────────────────────────────────────────────────────────────

function keywordRelevance(content: string, query: string): number {
  if (!query.trim()) return 0.5
  const words = query.toLowerCase().split(/\W+/).filter(w => w.length > 3)
  if (words.length === 0) return 0.5
  const lower = content.toLowerCase()
  const hits = words.filter(w => lower.includes(w)).length
  return hits / words.length
}

function recencyScore(index: number, total: number): number {
  if (total <= 1) return 1.0
  return index / (total - 1)  // 0 = oldest, 1 = newest
}

function compositeScore(authority: number, recency: number, relevance: number): number {
  return authority * (0.5 + 0.5 * recency) * (0.5 + 0.5 * relevance)
}

// ── Tail selection ────────────────────────────────────────────────────────────

/**
 * Select the last N turns from the conversation as raw messages.
 * Counts backwards finding N user messages as turn boundaries.
 */
function selectTailMessages(conversation: Message[], tailTurns: number): Message[] {
  if (tailTurns <= 0 || conversation.length === 0) return []
  let userCount = 0
  for (let i = conversation.length - 1; i >= 0; i--) {
    if (conversation[i]?.role === 'user') {
      userCount++
      if (userCount >= tailTurns) return conversation.slice(i)
    }
  }
  return conversation.slice(0)  // fewer turns than tailTurns — return all
}

// ── Default implementation ────────────────────────────────────────────────────

export class DefaultContextBroker implements ContextBroker {
  private readonly engine: IPromptEngine

  constructor(
    private readonly systemPrompt: string,
    private readonly fileTracker:  SessionFileTracker,
    private readonly tailTurns:    number = 3,
    engine?: IPromptEngine,
    private readonly factStore?: FactStore,
  ) {
    this.engine = engine ?? new PromptEngine()
  }

  async assemble(query: AgentContextQuery): Promise<AssembledContext> {
    const sections:   PromptSection[]    = []
    const candidates: ContextCandidate[] = []

    // ── Tier 0: Sticky sections (always included, budget reserved) ──────────

    // Base system prompt
    const systemText = this.systemPrompt
    if (systemText) {
      sections.push({
        id:              'system-prompt',
        priority:        100,
        weight:          1,
        estimatedTokens: estimateTokens(systemText),
        text:            () => systemText,
        tags:            ['system', 'constraint'],
        sticky:          true,
        phase:           'constraint',
      })
      candidates.push({
        source:      'system_prompt',
        content:     systemText,
        lane:        'sticky',
        mustInclude: true,
        score:       { recency: 1, relevance: 1, authority: 1 },
        metadata:    { tokens: estimateTokens(systemText) },
      })
    }

    // Session file tracker
    const fileSection = this.fileTracker.toPromptSection()
    if (fileSection) {
      sections.push(fileSection)
      candidates.push({
        source:      'session_file_tracker',
        content:     fileSection.text(),
        lane:        'sticky',
        mustInclude: true,
        score:       { recency: 1, relevance: 1, authority: 0.5 },
        metadata:    { tokens: fileSection.estimatedTokens },
      })
    }

    // ── Tier 2: Scored candidates — turn summaries (historical lane) ────────

    const totalSummaries = query.turnSummaries.length

    for (let i = 0; i < totalSummaries; i++) {
      const summary  = query.turnSummaries[i]!
      const recency  = recencyScore(i, totalSummaries)
      const hasUnresolved = summary.unresolvedItems.length > 0

      // Dynamic authority boost for summaries with unresolved work.
      const authority = 0.6 + (hasUnresolved ? 0.2 : 0)

      // Relevance floor: unresolved summaries are always at least partially relevant.
      const rawRelevance = keywordRelevance(formatSummary(summary), query.userInput)
      const relevance    = hasUnresolved ? Math.max(rawRelevance, 0.4) : rawRelevance

      const score: ContextScore = { recency, relevance, authority }
      const composite = compositeScore(authority, recency, relevance)

      const mustInclude  = hasUnresolved
      const summaryText  = formatSummary(summary)

      const section: PromptSection = {
        id:              `summary-${summary.turnId}`,
        priority:        authority * 100,
        weight:          0.5 + 0.5 * recency,
        contextMultiplier: 0.5 + 0.5 * relevance,
        estimatedTokens: summary.tokenEstimate || estimateTokens(summaryText),
        text:            () => summaryText,
        tags:            ['history', 'summary', ...(hasUnresolved ? ['unresolved'] : [])],
        sticky:          false,
        phase:           'history',
      }

      // Split-turn edge case: if a single summary is oversized, pre-truncate it.
      if (section.estimatedTokens > Math.floor(query.tokenBudget * 0.15)) {
        const truncated = truncateSummary(summary)
        section.estimatedTokens = estimateTokens(truncated)
        ;(section as { text: () => string }).text = () => truncated
      }

      sections.push(section)
      candidates.push({
        source:      'turn_summary',
        content:     summaryText,
        lane:        mustInclude ? 'must_include' : 'historical',
        mustInclude,
        score,
        metadata: {
          turnId:    summary.turnId,
          tokens:    section.estimatedTokens,
        },
      })

      // Boost must-include summaries so they survive budget pressure.
      if (mustInclude) {
        section.priority = Math.min(100, section.priority + 20)
      }

      // Track composite for diagnostics (unused at runtime, useful for debugging).
      void composite
    }

    // ── Tier 3: Memory — facts from FactStore (Phase E) ───────────────────

    if (this.factStore) {
      // Reserve ~15% of budget for memory sections.
      const memBudget = Math.floor(query.tokenBudget * 0.15)
      const factSections = await this.factStore.queryForContext(query.userInput, memBudget)
      for (const fs of factSections) {
        sections.push(fs)
        candidates.push({
          source:      'fact',
          content:     fs.text(),
          lane:        fs.sticky ? 'working_state' : 'semantic',
          mustInclude: fs.sticky ?? false,
          score:       { recency: 0.5, relevance: 0.7, authority: (fs.priority ?? 0) / 100 },
          metadata:    { tokens: fs.estimatedTokens },
        })
      }
    }

    // ── Budget enforcement ───────────────────────────────────────────────────

    const result = this.engine.compose(sections, query.tokenBudget)

    // ── Tail selection (messages — not rendered into system) ─────────────────
    // Reserve remaining budget for tail messages. If they exceed budget,
    // reduce tailTurns until they fit.

    const systemTokens = result.totalTokens
    const tailBudget = Math.max(0, query.tokenBudget - systemTokens)

    let tailMessages: Message[] = []
    for (let t = this.tailTurns; t > 0; t--) {
      const candidate = selectTailMessages(query.conversation, t)
      const tokens = estimateTokens(candidate.map(m => ('content' in m ? m.content : '')).join('\n'))
      if (tokens <= tailBudget) {
        tailMessages = candidate
        break
      }
    }
    // Always include at least the last message (the user's prompt).
    if (tailMessages.length === 0 && query.conversation.length > 0) {
      tailMessages = query.conversation.slice(-1)
    }

    // Track tail message candidates for contextUsed metadata.
    if (tailMessages.length > 0) {
      candidates.push({
        source:      'raw_turn',
        content:     `(${tailMessages.length} raw conversation messages)`,
        lane:        'tail',
        mustInclude: true,
        score:       { recency: 1, relevance: 1, authority: 0.9 },
        metadata:    { tokens: estimateTokens(tailMessages.map(m => ('content' in m ? m.content : '')).join('\n')) },
      })
    }

    return {
      system:     result.text,
      messages:   tailMessages,
      selections: candidates,
      stats:      result,
    }
  }
}
