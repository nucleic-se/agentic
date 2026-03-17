/**
 * TurnSummarizer — generates compressed turn summaries for context management.
 *
 * Summaries are context hints, not ground truth. They are lossy, model-generated,
 * and potentially wrong. The execution store (TurnRecord) is always authoritative.
 * If a summary contradicts tool results in the execution store, the store wins.
 *
 * Generated eagerly post-turn via the fast model tier — not as an emergency
 * fallback. This ensures consistent quality across the session.
 */

import { estimateTokens }  from '../../utils.js'
import type { IModelRouter } from '../../contracts/llm.js'
import type { TurnRecord, TurnOutcome } from '../../contracts/agent.js'

// ── Type ──────────────────────────────────────────────────────────────────────

export interface TurnSummary {
  turnId:          string
  userIntent:      string       // what the user was asking for this turn
  toolsUsed:       string[]     // tool names called
  filesRead:       string[]     // file paths that were read
  filesModified:   string[]     // file paths that were written/deleted/moved
  keyFindings:     string[]     // grounded in tool outputs, not pure inference
  unresolvedItems: string[]     // open questions or unfinished work
  outcome:         TurnOutcome
  tokenEstimate:   number       // estimated size of this summary in tokens
}

// ── Schema ────────────────────────────────────────────────────────────────────

const SUMMARY_SCHEMA = {
  type: 'object',
  required: ['userIntent', 'toolsUsed', 'filesRead', 'filesModified', 'keyFindings', 'unresolvedItems'],
  properties: {
    userIntent:      { type: 'string',                    description: 'One sentence: what the user was asking for' },
    toolsUsed:       { type: 'array', items: { type: 'string' }, description: 'Tool names that were called' },
    filesRead:       { type: 'array', items: { type: 'string' }, description: 'File paths that were read' },
    filesModified:   { type: 'array', items: { type: 'string' }, description: 'File paths written, deleted, or moved' },
    keyFindings:     { type: 'array', items: { type: 'string' }, description: 'Key facts discovered, grounded in tool outputs. Empty array if none.' },
    unresolvedItems: { type: 'array', items: { type: 'string' }, description: 'Work left open or questions not yet answered. Empty array if fully resolved.' },
  },
} as const

// ── Summarizer ────────────────────────────────────────────────────────────────

export async function summarizeTurn(
  record: TurnRecord,
  router: IModelRouter,
): Promise<TurnSummary> {
  const provider = router.select('fast')

  // Build a concise description of the turn for the summarizer.
  const execLines = record.executions
    .filter(e => e.status === 'success' || e.status === 'runtime_failure')
    .map(e => {
      const preview = (e.result?.content ?? e.error ?? '').slice(0, 300).replace(/\n/g, ' ')
      return `  ${e.plan.name}: ${e.status} — ${preview}`
    })
    .join('\n')

  const assistantText = record.modelResponse.content.slice(0, 500)

  const prompt = [
    `Summarize the following agent turn for context compression.`,
    ``,
    `Outcome: ${record.outcome}`,
    `Duration: ${record.durationMs}ms`,
    ``,
    execLines ? `Tool executions:\n${execLines}` : `Tool executions: (none)`,
    ``,
    assistantText ? `Assistant response (first 500 chars):\n${assistantText}` : '',
  ].filter(Boolean).join('\n')

  const response = await provider.structured<Omit<TurnSummary, 'turnId' | 'outcome' | 'tokenEstimate'>>({
    messages: [{ role: 'user', content: prompt }],
    schema:   SUMMARY_SCHEMA as unknown as import('../../contracts/shared.js').JsonSchema,
  })

  const summary: TurnSummary = {
    turnId:          record.turnId,
    userIntent:      response.value.userIntent      ?? '',
    toolsUsed:       response.value.toolsUsed       ?? [],
    filesRead:       response.value.filesRead        ?? [],
    filesModified:   response.value.filesModified    ?? [],
    keyFindings:     response.value.keyFindings      ?? [],
    unresolvedItems: response.value.unresolvedItems  ?? [],
    outcome:         record.outcome,
    tokenEstimate:   0,
  }
  summary.tokenEstimate = estimateTokens(formatSummary(summary))
  return summary
}

/** Render a TurnSummary as a human-readable string for IPromptEngine. */
export function formatSummary(summary: TurnSummary): string {
  const lines: string[] = [
    `Turn ${summary.turnId.slice(0, 8)} [${summary.outcome}]`,
    `Intent: ${summary.userIntent}`,
  ]
  if (summary.toolsUsed.length)       lines.push(`Tools: ${summary.toolsUsed.join(', ')}`)
  if (summary.filesRead.length)        lines.push(`Read: ${summary.filesRead.join(', ')}`)
  if (summary.filesModified.length)    lines.push(`Modified: ${summary.filesModified.join(', ')}`)
  if (summary.keyFindings.length) {
    lines.push('Findings:')
    for (const f of summary.keyFindings) lines.push(`  - ${f}`)
  }
  if (summary.unresolvedItems.length) {
    lines.push('Unresolved:')
    for (const u of summary.unresolvedItems) lines.push(`  - ${u}`)
  }
  return lines.join('\n')
}

/** Truncated fallback for summaries that exceed budget even after scoring. */
export function truncateSummary(summary: TurnSummary): string {
  const lines: string[] = [
    `Turn ${summary.turnId.slice(0, 8)} [${summary.outcome}]`,
    `Intent: ${summary.userIntent}`,
  ]
  for (const f of summary.keyFindings.slice(0, 2))     lines.push(`  - ${f.slice(0, 200)}`)
  for (const u of summary.unresolvedItems.slice(0, 2)) lines.push(`  ? ${u.slice(0, 200)}`)
  return lines.join('\n')
}

/** Returns true for turns that warrant a summary (non-trivial, completed turns). */
export function shouldSummarize(record: TurnRecord): boolean {
  // Skip failed/aborted turns with no meaningful content.
  if (record.outcome === 'failed') return false
  // Turns with tool calls or substantive assistant responses are worth summarizing.
  return record.executions.length > 0 || record.modelResponse.content.length > 50
}
