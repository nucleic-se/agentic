/**
 * SessionFileTracker — cumulative read/write path tracking across turns.
 *
 * Acts as a persistent working-set anchor in the system prompt. Under extreme
 * budget pressure, all TurnSummaries may be dropped; the model still knows
 * what it has touched. At ~50 tokens it unconditionally earns its budget.
 *
 * Sticky in IPromptEngine — never dropped by budget enforcement.
 */

import { estimateTokens }     from '../../utils.js'
import type { PromptSection } from '../../contracts/IPromptEngine.js'

export class SessionFileTracker {
  private readonly read    = new Set<string>()
  private readonly written = new Set<string>()

  /**
   * Record a successful tool execution. Extracts paths from args based on
   * tool name conventions used by the coding tools.
   */
  record(toolName: string, args: Record<string, unknown>): void {
    const path = typeof args['path'] === 'string' ? args['path'] : undefined
    const from = typeof args['from'] === 'string' ? args['from'] : undefined
    const to   = typeof args['to']   === 'string' ? args['to']   : undefined

    switch (toolName) {
      case 'fs_read':
      case 'fs_list':
        if (path) this.read.add(path)
        break
      case 'fs_write':
        if (path) this.written.add(path)
        break
      case 'fs_delete':
        if (path) this.written.add(path)
        break
      case 'fs_move':
        if (from) this.read.add(from)
        if (to)   this.written.add(to)
        break
      // shell_run and fetch_* don't have meaningful path tracking
    }
  }

  /** Returns a sticky PromptSection, or null if nothing has been tracked. */
  toPromptSection(): PromptSection | null {
    if (this.read.size === 0 && this.written.size === 0) return null

    const lines: string[] = []
    if (this.read.size > 0) {
      lines.push('Files read this session:')
      for (const p of this.read) lines.push(`  ${p}`)
    }
    if (this.written.size > 0) {
      if (lines.length > 0) lines.push('')
      lines.push('Files modified this session:')
      for (const p of this.written) lines.push(`  ${p}`)
    }
    const text = lines.join('\n')

    return {
      id:              'session-file-tracker',
      priority:        50,
      weight:          1,
      estimatedTokens: estimateTokens(text),
      text:            () => text,
      tags:            ['file-tracker', 'structural'],
      sticky:          true,
      phase:           'constraint',
    }
  }

  /** Returns paths written in the last `turns` turn IDs (for must-include active files). */
  getRecentWritten(): ReadonlySet<string> { return this.written }
  getRecentRead():    ReadonlySet<string> { return this.read }

  clear(): void { this.read.clear(); this.written.clear() }
}
