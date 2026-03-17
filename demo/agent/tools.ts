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
import type { IToolRuntime }    from '../../contracts/tool-runtime.js'

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
