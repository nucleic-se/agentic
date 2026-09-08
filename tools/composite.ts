/**
 * CompositeToolRuntime — collision-safe dispatch across tool runtimes.
 *
 * Authorization is owned by the agent kernel. The composite only discovers
 * tools and forwards already-authorized calls with their execution options.
 */

import type { ToolDefinition } from '../contracts/llm.js';
import type {
    IToolRuntime,
    IValidatedToolRuntime,
    ToolCallOptions,
    ToolCallResult,
    ToolCallValidation,
} from '../contracts/tool-runtime.js';
import type { ToolTrustTier } from '../contracts/ITool.js';

interface IToolRuntimeWithMeta extends IToolRuntime {
    mutatingToolNames(): ReadonlySet<string>;
    isMutatingCall?(name: string, args: Record<string, unknown>): boolean;
}

export class CompositeToolRuntime implements IToolRuntimeWithMeta, IValidatedToolRuntime {
    async close(): Promise<void> {
        const results = await Promise.allSettled([...this.runtimes].map(async runtime => runtime.close?.()));
        const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, 'Tool runtime cleanup failed');
    }
    private readonly map = new Map<string, IToolRuntime>();
    private readonly defs: ToolDefinition[] = [];
    private readonly mutating = new Set<string>();
    private readonly runtimes: Set<IToolRuntime>;

    constructor(runtimes: IToolRuntime[]) {
        this.runtimes = new Set(runtimes);
        for (const runtime of runtimes) {
            for (const definition of runtime.tools()) {
                if (this.map.has(definition.name)) {
                    throw new Error(`Tool '${definition.name}' is already registered`);
                }
                this.defs.push(definition);
                this.map.set(definition.name, runtime);
            }
            if (typeof (runtime as IToolRuntimeWithMeta).mutatingToolNames === 'function') {
                for (const name of (runtime as IToolRuntimeWithMeta).mutatingToolNames()) {
                    this.mutating.add(name);
                }
            }
        }
    }

    tools(): ToolDefinition[] {
        return [...this.defs];
    }

    trustTierFor(name: string): ToolTrustTier | undefined {
        return this.map.get(name)?.trustTierFor?.(name);
    }

    effectFor(name: string): 'read' | 'write' | undefined {
        return this.map.get(name)?.effectFor?.(name);
    }

    validate(name: string, args: Record<string, unknown>): ToolCallValidation {
        const runtime = this.map.get(name);
        if (!runtime) {
            return {
                ok: false,
                result: { ok: false, content: `Unknown tool: ${name}`, errorKind: 'unknown' },
            };
        }
        if (typeof (runtime as Partial<IValidatedToolRuntime>).validate !== 'function') {
            return {
                ok: false,
                result: {
                    ok: false,
                    content: `Tool runtime for '${name}' does not support preflight validation`,
                    errorKind: 'validation',
                },
            };
        }
        return (runtime as IValidatedToolRuntime).validate(name, args);
    }

    async call(
        name: string,
        args: Record<string, unknown>,
        options?: ToolCallOptions,
    ): Promise<ToolCallResult> {
        const runtime = this.map.get(name);
        if (!runtime) {
            return { ok: false, content: `Unknown tool: ${name}`, errorKind: 'unknown' };
        }
        return runtime.call(name, args, options);
    }

    mutatingToolNames(): ReadonlySet<string> {
        return this.mutating;
    }

    isMutatingCall(name: string, args: Record<string, unknown>): boolean {
        const runtime = this.map.get(name);
        if (!runtime) return false;
        if (typeof (runtime as IToolRuntimeWithMeta).isMutatingCall === 'function') {
            return (runtime as IToolRuntimeWithMeta).isMutatingCall!(name, args);
        }
        return this.mutating.has(name);
    }
}
