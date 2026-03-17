/**
 * FactExtractor — post-turn extraction of persistent facts from tool results.
 *
 * Runs fire-and-forget via the fast model tier, similar to TurnSummarizer.
 * Extracted facts are written to FactStore as semantic memory items.
 *
 * Only extracts from turns with successful tool calls that produced
 * substantive content (file reads, shell output, fetch results).
 */

import type { IModelRouter } from '../../contracts/llm.js'
import type { TurnRecord }   from '../../contracts/agent.js'
import type { FactStore, FactEntry } from './fact-store.js'

const EXTRACT_SCHEMA = {
  type: 'object',
  required: ['facts'],
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['key', 'value', 'confidence'],
        properties: {
          key:        { type: 'string', description: 'Short identifier for the fact (e.g. "api_base_url", "test_framework")' },
          value:      { type: 'string', description: 'The fact itself, grounded in tool output' },
          confidence: { type: 'number', description: '0.0–1.0 confidence that this fact is correct and worth remembering' },
        },
      },
      description: 'Facts discovered in this turn. Empty array if none worth persisting.',
    },
  },
} as const

/** Returns true for turns that might contain extractable facts. */
export function shouldExtractFacts(record: TurnRecord): boolean {
  // Only extract from turns with successful tool calls that produced output.
  return record.executions.some(
    ex => ex.status === 'success' && ex.result?.content && ex.result.content.length > 20
  )
}

/** Extract facts from a turn record and write them to the fact store. */
export async function extractFacts(
  record:   TurnRecord,
  router:   IModelRouter,
  store:    FactStore,
): Promise<FactEntry[]> {
  const provider = router.select('fast')

  // Build a concise description of tool results for the extractor.
  const resultLines = record.executions
    .filter(e => e.status === 'success' && e.result?.content)
    .map(e => {
      const preview = (e.result?.content ?? '').slice(0, 500).replace(/\n/g, ' ')
      return `  ${e.plan.name}: ${preview}`
    })
    .join('\n')

  if (!resultLines) return []

  const prompt = [
    `Extract persistent facts from the following tool results.`,
    `Only include facts that would be useful in future turns (file paths, project structure, config values, API endpoints, error patterns).`,
    `Do NOT include ephemeral data (timestamps, process IDs, etc).`,
    `If nothing is worth remembering, return an empty facts array.`,
    ``,
    `Tool results:`,
    resultLines,
  ].join('\n')

  const response = await provider.structured<{ facts: FactEntry[] }>({
    messages: [{ role: 'user', content: prompt }],
    schema:   EXTRACT_SCHEMA as unknown as import('../../contracts/shared.js').JsonSchema,
  })

  const facts = response.value.facts ?? []

  // Write extracted facts to the store.
  for (const fact of facts) {
    if (fact.key && fact.value && (fact.confidence ?? 0) > 0.3) {
      await store.addFact({
        key:        fact.key,
        value:      fact.value,
        confidence: fact.confidence,
        source:     'fact_extractor',
      })
    }
  }

  return facts
}
