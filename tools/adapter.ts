/**
 * ToolRuntimeAdapter — wraps ITool[] as IToolRuntime.
 *
 * Bridges the typed ITool system and the IToolRuntime dispatch surface.
 * Applies an optional IToolPolicy before calling execute().
 */

import type { ToolDefinition } from '../contracts/llm.js';
import type { IToolRuntime, ToolCallResult, ToolCallOptions } from '../contracts/tool-runtime.js';
import type { ITool, ToolTrustTier } from '../contracts/ITool.js';
import type { IToolPolicy } from '../contracts/IToolPolicy.js';

function toResult(raw: unknown): ToolCallResult {
    if (typeof raw === 'string') {
        return { ok: true, content: raw };
    }
    if (raw == null) {
        return { ok: true, content: '' };
    }
    const content = JSON.stringify(raw);
    return { ok: true, content, data: raw };
}

export class ToolRuntimeAdapter implements IToolRuntime {
    private readonly toolMap = new Map<string, ITool>();
    private readonly defs: ToolDefinition[] = [];
    private readonly policy?: IToolPolicy;

    constructor(tools: ITool[], policy?: IToolPolicy) {
        this.policy = policy;
        for (const tool of tools) {
            this.toolMap.set(tool.name, tool);
            this.defs.push({
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
            });
        }
    }

    tools(): ToolDefinition[] {
        return this.defs;
    }

    trustTierFor(name: string): ToolTrustTier | undefined {
        return this.toolMap.get(name)?.trustTier;
    }

    async call(name: string, args: Record<string, unknown>, _options?: ToolCallOptions): Promise<ToolCallResult> {
        const tool = this.toolMap.get(name);
        if (!tool) {
            return { ok: false, content: `unknown tool: ${name}` };
        }

        if (this.policy) {
            const decision = await this.policy.evaluate({
                callId: `adapter-${name}-${Date.now()}`,
                name,
                args,
                trustTier: tool.trustTier,
            });
            if (decision.kind === 'deny') {
                return { ok: false, content: decision.reason };
            }
            if (decision.kind === 'rewrite') {
                try {
                    return toResult(await tool.execute(decision.args));
                } catch (err) {
                    return { ok: false, content: (err as Error).message };
                }
            }
            // 'allow' and 'confirm' fall through
        }

        try {
            return toResult(await tool.execute(args));
        } catch (err) {
            return { ok: false, content: (err as Error).message };
        }
    }
}
