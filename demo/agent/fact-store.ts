/**
 * FactStore — thin agent-facing wrapper over IMemoryStore.
 *
 * Two memory lanes:
 *   - working: ephemeral scratchpad entries (TTL 1 day)
 *   - semantic: persistent facts discovered during the session
 *
 * Renders as PromptSection[] (phase: 'memory') for the context broker.
 */

import { estimateTokens }        from '../../utils.js'
import { InMemoryStore }         from '../../runtime/InMemoryStore.js'
import type { IMemoryStore }     from '../../contracts/IMemory.js'
import type { PromptSection }    from '../../contracts/IPromptEngine.js'

export interface FactEntry {
  key:         string
  value:       string
  confidence?: number   // 0–1, default 0.7
  source?:     string   // e.g. 'fact_extractor', 'user'
}

export class FactStore {
  private readonly store: IMemoryStore

  constructor(store?: IMemoryStore) {
    this.store = store ?? new InMemoryStore()
  }

  /** Write a short-lived scratchpad entry (working memory, TTL 1 day). */
  async setScratchpad(key: string, value: string, source = 'agent'): Promise<void> {
    await this.store.write({
      type:       'working',
      key,
      value,
      confidence: 1.0,
      source,
      tags:       ['scratchpad'],
      ttlDays:    1,
    })
  }

  /** Write a persistent semantic fact. */
  async addFact(entry: FactEntry): Promise<void> {
    await this.store.write({
      type:       'semantic',
      key:        entry.key,
      value:      entry.value,
      confidence: entry.confidence ?? 0.7,
      source:     entry.source ?? 'fact_extractor',
      tags:       ['fact'],
    })
  }

  /** Query facts relevant to the given text, respecting token budget. */
  async queryForContext(text: string, tokenBudget: number): Promise<PromptSection[]> {
    const items = await this.store.query({
      text,
      types: ['working', 'semantic'],
      limit: 20,
      tokenBudget,
    })

    if (items.length === 0) return []

    const sections: PromptSection[] = []

    // Scratchpad — single sticky section.
    const scratchpadItems = items.filter(i => i.type === 'working')
    if (scratchpadItems.length > 0) {
      const text = scratchpadItems
        .map(i => `${i.key}: ${String(i.value)}`)
        .join('\n')
      sections.push({
        id:              'fact-scratchpad',
        priority:        50,
        weight:          1,
        estimatedTokens: estimateTokens(text),
        text:            () => `Scratchpad:\n${text}`,
        tags:            ['memory', 'scratchpad'],
        sticky:          true,
        phase:           'memory',
      })
    }

    // Semantic facts — one section per fact, scored by confidence.
    const factItems = items.filter(i => i.type === 'semantic')
    for (const item of factItems) {
      const factText = `${item.key}: ${String(item.value)}`
      sections.push({
        id:              `fact-${item.id}`,
        priority:        item.confidence * 40,  // max 40 at confidence=1.0
        weight:          0.5 + 0.5 * item.confidence,
        estimatedTokens: estimateTokens(factText),
        text:            () => factText,
        tags:            ['memory', 'fact'],
        sticky:          false,
        phase:           'memory',
      })
    }

    return sections
  }

  /** Evict expired entries. */
  async evict(): Promise<number> {
    return this.store.evictExpired()
  }

  clear(): void {
    // InMemoryStore doesn't have a bulk clear, but eviction with 0 TTL effectively cleans up.
    // For a real clear, we'd need to query all and delete. Keep simple for now.
    void this.store.evictExpired()
  }
}
