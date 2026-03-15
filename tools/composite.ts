/**
 * CompositeToolRuntime — merges multiple IToolRuntime instances into one.
 *
 * Tools from each runtime are namespaced by prefix (e.g. "fs_", "fetch_").
 * The composite dispatches calls to the correct runtime by name lookup.
 *
 * Usage:
 *   const runtime = new CompositeToolRuntime([
 *       new FsToolRuntime(workDir),
 *       new FetchToolRuntime(),
 *       new ShellToolRuntime(workDir),
 *       new SearchToolRuntime(workDir),
 *   ])
 */

import type { ToolDefinition } from '../contracts/llm.js'
import type { IToolRuntime, ToolCallResult } from '../contracts/tool-runtime.js'

interface IToolRuntimeWithMeta extends IToolRuntime {
    mutatingToolNames(): ReadonlySet<string>
    isMutatingCall?(name: string, args: Record<string, unknown>): boolean
}

export class CompositeToolRuntime implements IToolRuntimeWithMeta {
    private readonly map = new Map<string, IToolRuntime>()
    private readonly defs: ToolDefinition[] = []
    private readonly mutating = new Set<string>()

    constructor(runtimes: IToolRuntime[]) {
        for (const rt of runtimes) {
            for (const def of rt.tools()) {
                this.defs.push(def)
                this.map.set(def.name, rt)
            }
            if (typeof (rt as IToolRuntimeWithMeta).mutatingToolNames === 'function') {
                for (const name of (rt as IToolRuntimeWithMeta).mutatingToolNames()) {
                    this.mutating.add(name)
                }
            }
        }
    }

    tools(): ToolDefinition[] {
        return this.defs
    }

    async call(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
        const rt = this.map.get(name)
        if (!rt) return { ok: false, content: `Unknown tool: ${name}` }
        return rt.call(name, args)
    }

    mutatingToolNames(): ReadonlySet<string> {
        return this.mutating
    }

    isMutatingCall(name: string, args: Record<string, unknown>): boolean {
        const rt = this.map.get(name)
        if (!rt) return false
        if (typeof (rt as IToolRuntimeWithMeta).isMutatingCall === 'function') {
            return (rt as IToolRuntimeWithMeta).isMutatingCall!(name, args)
        }
        return this.mutating.has(name)
    }
}
