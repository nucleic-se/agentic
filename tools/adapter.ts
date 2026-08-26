/**
 * ToolRuntimeAdapter — validated execution for typed Agentic tools.
 *
 * Authorization deliberately does not live here. The agent kernel evaluates
 * policy and resolves confirmation before dispatching an approved call.
 */

import type { ToolDefinition } from '../contracts/llm.js';
import type {
    IValidatedToolRuntime,
    ToolCallResult,
    ToolCallOptions,
    ToolCallValidation,
} from '../contracts/tool-runtime.js';
import type {
    ITool,
    ToolExecutionContext,
    ToolTrustTier,
    ValidationIssue,
} from '../contracts/ITool.js';

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

function formatIssues(direction: 'input' | 'output', issues: readonly ValidationIssue[]): string {
    const details = issues.map(issue => {
        const path = issue.path?.length ? `${issue.path.join('.')}: ` : '';
        return `${path}${issue.message}`;
    });
    return `Invalid tool ${direction}: ${details.join('; ') || 'validation failed'}`;
}

export class ToolRuntimeAdapter implements IValidatedToolRuntime {
    private readonly toolMap = new Map<string, ITool>();
    private readonly defs: ToolDefinition[] = [];

    constructor(tools: ITool[]) {
        for (const tool of tools) {
            if (!tool.name.trim()) {
                throw new Error('Tool name must be a non-empty string');
            }
            if (this.toolMap.has(tool.name)) {
                throw new Error(`Tool '${tool.name}' is already registered`);
            }
            if (tool.timeoutMs != null && (!Number.isFinite(tool.timeoutMs) || tool.timeoutMs <= 0)) {
                throw new Error(`Tool '${tool.name}' timeoutMs must be a positive finite number`);
            }
            this.toolMap.set(tool.name, tool);
            this.defs.push({
                name: tool.name,
                description: tool.description,
                parameters: tool.input.jsonSchema,
            });
        }
    }

    tools(): ToolDefinition[] {
        return [...this.defs];
    }

    trustTierFor(name: string): ToolTrustTier | undefined {
        return this.toolMap.get(name)?.trustTier;
    }

    validate(name: string, args: Record<string, unknown>): ToolCallValidation {
        const tool = this.toolMap.get(name);
        if (!tool) {
            return {
                ok: false,
                result: { ok: false, content: `Unknown tool: ${name}`, errorKind: 'unknown' },
            };
        }

        let input;
        try {
            input = tool.input.validate(args);
        } catch (error) {
            return { ok: false, result: {
                ok: false,
                content: `Invalid tool input: validator threw: ${error instanceof Error ? error.message : String(error)}`,
                errorKind: 'validation',
            } };
        }
        if (!input.ok) {
            return {
                ok: false,
                result: { ok: false, content: formatIssues('input', input.issues), errorKind: 'validation' },
            };
        }
        if (typeof input.value !== 'object' || input.value === null || Array.isArray(input.value)) {
            return {
                ok: false,
                result: {
                    ok: false,
                    content: 'Invalid tool input: validated tool arguments must be an object',
                    errorKind: 'validation',
                },
            };
        }
        return { ok: true, args: input.value as Record<string, unknown> };
    }

    async call(name: string, args: Record<string, unknown>, options?: ToolCallOptions): Promise<ToolCallResult> {
        const tool = this.toolMap.get(name);
        if (!tool) {
            return { ok: false, content: `Unknown tool: ${name}`, errorKind: 'unknown' };
        }
        const validation = this.validate(name, args);
        if (!validation.ok) return validation.result;

        if (options?.signal?.aborted) {
            return { ok: false, content: `Tool call cancelled: ${name}`, errorKind: 'cancelled' };
        }

        const controller = new AbortController();
        let timedOut = false;
        const forwardAbort = () => controller.abort(options?.signal?.reason);
        options?.signal?.addEventListener('abort', forwardAbort, { once: true });

        const timer = tool.timeoutMs == null
            ? undefined
            : setTimeout(() => {
                timedOut = true;
                controller.abort(new Error(`Tool '${name}' timed out after ${tool.timeoutMs}ms`));
            }, tool.timeoutMs);

        const context: ToolExecutionContext = {
            callId: options?.callId ?? `tool-${name}-${Date.now()}`,
            signal: controller.signal,
            ...(options?.onUpdate ? { onUpdate: options.onUpdate } : {}),
        };

        const cancelled = new Promise<never>((_resolve, reject) => {
            controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
        });

        try {
            const raw = await Promise.race([
                Promise.resolve().then(() => tool.execute(validation.args, context)),
                cancelled,
            ]);

            if (tool.output) {
                let output;
                try {
                    output = tool.output.validate(raw);
                } catch (error) {
                    return {
                        ok: false,
                        content: `Invalid tool output: validator threw: ${error instanceof Error ? error.message : String(error)}`,
                        errorKind: 'validation',
                    };
                }
                if (!output.ok) {
                    return { ok: false, content: formatIssues('output', output.issues), errorKind: 'validation' };
                }
                return toResult(output.value);
            }

            return toResult(raw);
        } catch (error) {
            if (controller.signal.aborted) {
                return timedOut
                    ? { ok: false, content: `Tool timed out: ${name}`, errorKind: 'timeout' }
                    : { ok: false, content: `Tool call cancelled: ${name}`, errorKind: 'cancelled' };
            }
            return {
                ok: false,
                content: error instanceof Error ? error.message : String(error),
                errorKind: 'runtime',
            };
        } finally {
            if (timer) clearTimeout(timer);
            options?.signal?.removeEventListener('abort', forwardAbort);
        }
    }
}
