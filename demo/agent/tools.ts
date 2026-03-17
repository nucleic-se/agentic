/**
 * createCodingTools — default tool set for CodingAgent.
 *
 * Composes the library's tool runtimes into a single IToolRuntime:
 *   fs_read, fs_write, fs_list, fs_delete, fs_move  — FsToolRuntime
 *   shell_run                                        — ShellToolRuntime
 *   fetch_get, fetch_post                            — FetchToolRuntime
 *
 * All tools are scoped to `cwd` (working directory).
 */

import { FsToolRuntime }        from '../../tools/fs.js'
import { ShellToolRuntime }     from '../../tools/shell.js'
import { FetchToolRuntime }     from '../../tools/fetch.js'
import { CompositeToolRuntime } from '../../tools/composite.js'
import { ToolRegistry }         from '../../runtime/ToolRegistry.js'
import type { IToolRuntime }    from '../../contracts/tool-runtime.js'
import type { IToolRegistry, ToolTrustTier } from '../../contracts/ITool.js'

// ── Trust tier map ────────────────────────────────────────────────────────────

/** Canonical trust tier for each coding tool. Default for unknowns: 'standard'. */
const TOOL_TRUST_TIERS: Record<string, ToolTrustTier> = {
  fs_read:   'trusted',
  fs_list:   'trusted',
  fs_write:  'standard',
  fs_delete: 'standard',
  fs_move:   'standard',
  shell_run: 'standard',
  fetch_get:  'untrusted',
  fetch_post: 'untrusted',
}

// ── Factory ───────────────────────────────────────────────────────────────────

export interface CreateCodingToolsOptions {
  /** Working directory for filesystem and shell operations. Defaults to process.cwd(). */
  cwd?: string
}

export function createCodingTools(options: CreateCodingToolsOptions = {}): IToolRuntime {
  const cwd = options.cwd ?? process.cwd()
  return new CompositeToolRuntime([
    new FsToolRuntime(cwd),
    new ShellToolRuntime(cwd),
    new FetchToolRuntime(),
  ])
}

/**
 * Build an IToolRegistry from an existing IToolRuntime.
 *
 * Reads tool definitions from the runtime and registers lightweight metadata
 * shims with the correct trust tiers. The registry is used by DefaultToolPolicy
 * for allow/deny decisions and by the kernel for ToolPlan.trustTier assignment.
 *
 * The registered ITool.execute() always throws — execution goes through
 * IToolRuntime, not the registry.
 */
export function createCodingRegistry(runtime: IToolRuntime): IToolRegistry {
  const registry = new ToolRegistry()
  for (const def of runtime.tools()) {
    const trustTier: ToolTrustTier = TOOL_TRUST_TIERS[def.name] ?? 'standard'
    registry.register({
      name:        def.name,
      description: def.description,
      inputSchema: def.parameters,
      trustTier,
      execute:     () => Promise.reject(new Error('Use IToolRuntime for execution')),
    })
  }
  return registry
}
