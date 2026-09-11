import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { LLMProtocolError } from '../contracts/llm.js';
import type { ToolCall, Message } from '../contracts/llm.js';
import type { ToolExecution, ToolPlan, AgentEventSink, Failure } from '../contracts/agent.js';
import type { IToolPolicy, PolicyContext } from '../contracts/IToolPolicy.js';
import type { IValidatedToolRuntime, ToolCallResult } from '../contracts/tool-runtime.js';

export const DEFAULT_MAX_TOOL_CALLS_PER_TURN = 16;

export interface BeforeToolCallResult {
    action: 'continue' | 'skip';
    args?: Record<string, unknown>;
    reason?: string;
}

/** The shared validation, authorization and dispatch configuration; no model dependencies. */
export interface ToolBatchConfig {
    tools: IValidatedToolRuntime;
    policy?: IToolPolicy;
    maxToolCallsPerTurn?: number;
    confirmToolCall?: (context: PolicyContext & { reason: string }) => Promise<boolean> | boolean;
    beforeToolCall?: (context: PolicyContext) => Promise<BeforeToolCallResult> | BeforeToolCallResult;
    /** Transform presentation only. The raw receipt and effect status are preserved. */
    afterToolCall?: (context: PolicyContext & {
        result: ToolCallResult;
        latencyMs: number;
    }) => Promise<ToolCallResult | void> | ToolCallResult | void;
}

export interface ToolBatchOptions extends ToolBatchConfig {
    /** Forward the host-owned durable session identity to tools. */
    sessionId?: string;
    signal?: AbortSignal;
    emit?: AgentEventSink;
    /** Correlates tool events with a caller-owned operation or turn. */
    turnId?: string;
}

export interface ToolBatchExecutionOptions extends ToolBatchOptions {
    /** Polled between completed calls, before the next call can start. */
    getSteeringMessages?: () => Promise<Message[]>;
}

export interface ToolBatchExecutionResult {
    plans: ToolPlan[];
    executions: ToolExecution[];
    interruption: 'abort' | 'steering' | null;
    steeringMessages: Message[];
    controlFailure?: Failure;
}

interface PreparedCall {
    plan: ToolPlan;
    authorizedInput?: Record<string, unknown>;
    blocked?: ToolExecution;
    validation?: ReturnType<IValidatedToolRuntime['validate']>;
}

function policyContext(plan: ToolPlan): PolicyContext {
    return {
        callId: plan.callId,
        name: plan.name,
        args: structuredClone(plan.input) as Record<string, unknown>,
        trustTier: plan.trustTier ?? 'standard',
    };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function extensionFailure(extension: string, error: unknown): Failure {
    return { kind: 'extension_error', message: `${extension} failed: ${errorMessage(error)}` };
}

function safeValidate(
    tools: IValidatedToolRuntime,
    name: string,
    args: Record<string, unknown>,
): ReturnType<IValidatedToolRuntime['validate']> {
    try {
        return tools.validate(name, args);
    } catch (error) {
        return {
            ok: false,
            result: {
                ok: false,
                content: `Tool preflight validation failed: ${errorMessage(error)}`,
                errorKind: 'validation',
            },
        };
    }
}

/**
 * Execute an already-proposed batch through the shared authorization boundary.
 * This primitive owns no provider, conversation, turn records or loop lifecycle.
 * Every call is validated and authorized before the first executable call starts.
 * Event sinks are awaited so durable callers can commit intent before dispatch.
 */
export async function executeToolBatchDetailed(
    calls: ToolCall[], config: ToolBatchExecutionOptions,
): Promise<ToolBatchExecutionResult> {
    const maxCalls = config.maxToolCallsPerTurn ?? DEFAULT_MAX_TOOL_CALLS_PER_TURN;
    if (!Number.isSafeInteger(maxCalls) || maxCalls < 1) {
        throw new RangeError('maxToolCallsPerTurn must be a positive safe integer');
    }
    if (calls.length > maxCalls) {
        throw new LLMProtocolError(`Provider returned ${calls.length} tool calls; maximum is ${maxCalls}`);
    }
    const ids = new Set<string>();
    for (const call of calls) {
        if (ids.has(call.id)) {
            throw new LLMProtocolError(`Provider returned duplicate tool call id '${call.id}'`);
        }
        ids.add(call.id);
    }
    const signal = config.signal;
    const emit = config.emit ?? (() => { });
    const turnId = config.turnId ?? randomUUID();
    const prepared: PreparedCall[] = structuredClone(calls).map(call => ({
        plan: {
            callId: call.id,
            name: call.name,
            input: call.args,
            trustTier: config.tools.trustTierFor?.(call.name) ?? 'standard',
        }
    }));

    // Raw model arguments must be valid before policy or confirmation sees them.
    for (const item of prepared) {
        item.validation = safeValidate(config.tools, item.plan.name, item.plan.input as Record<string, unknown>);
        if (item.validation.ok) {
            item.plan.input = item.validation.args;
        }
    }

    const independentReads = prepared.every(item => config.tools.effectFor?.(item.plan.name) === 'read');
    const rawBatchRejected = !independentReads && prepared.some(item => item.validation?.ok === false);
    if (!rawBatchRejected) {
        // Resolve authorization and call-transform hooks for the whole batch.
        for (const item of prepared) {
            if (!item.validation?.ok) {
                continue;
            }
            if (config.beforeToolCall) {
                let hook: BeforeToolCallResult;
                try {
                    hook = await config.beforeToolCall(policyContext(item.plan));
                } catch (error) {
                    item.blocked = {
                        callId: item.plan.callId,
                        plan: item.plan,
                        status: 'policy_denied',
                        dispatched: false,
                        error: `beforeToolCall failed closed: ${errorMessage(error)}`
                    };
                    continue;
                }
                if (hook.action === 'skip') {
                    item.blocked = {
                        callId: item.plan.callId,
                        plan: item.plan,
                        status: 'skipped',
                        dispatched: false,
                        error: hook.reason ?? 'Skipped by beforeToolCall hook'
                    };
                    continue;
                }
                if (hook.args) {
                    item.plan.input = hook.args;
                }
            }
            item.validation = safeValidate(config.tools, item.plan.name, item.plan.input as Record<string, unknown>);
            if (!item.validation.ok) {
                continue;
            }
            item.plan.input = item.validation.args;
            if (config.policy) {
                let decision;
                try {
                    decision = await config.policy.evaluate(policyContext(item.plan));
                } catch (error) {
                    decision = {
                        kind: 'deny' as const,
                        reason: `Policy evaluation failed: ${error instanceof Error ? error.message : String(error)}`
                    };
                }
                if (decision.kind === 'deny') {
                    item.blocked = {
                        callId: item.plan.callId,
                        plan: item.plan,
                        status: 'policy_denied',
                        dispatched: false,
                        error: decision.reason
                    };
                    continue;
                }
                if (decision.kind === 'confirm') {
                    // Confirmation must display the exact arguments that
                    // will execute, including a composed policy rewrite.
                    if (decision.args) {
                        item.plan.input = decision.args;
                    }
                    item.validation = safeValidate(config.tools, item.plan.name, item.plan.input as Record<string, unknown>);
                    if (!item.validation.ok) {
                        continue;
                    }
                    item.plan.input = item.validation.args;
                    let confirmed = false;
                    let confirmationError: unknown;
                    if (config.confirmToolCall) {
                        try {
                            confirmed = await config.confirmToolCall({
                                ...policyContext(item.plan), reason: decision.reason,
                            });
                        } catch (error) {
                            confirmationError = error;
                        }
                    }
                    if (!confirmed) {
                        item.blocked = {
                            callId: item.plan.callId,
                            plan: item.plan,
                            status: 'policy_denied',
                            dispatched: false,
                            error: confirmationError
                                ? `Confirmation failed closed: ${errorMessage(confirmationError)}`
                                : `Confirmation denied: ${decision.reason}`
                        };
                        continue;
                    }
                }
                if (decision.kind === 'rewrite') {
                    item.validation = safeValidate(config.tools, item.plan.name, decision.args);
                    if (!item.validation.ok) {
                        continue;
                    }
                    item.plan.input = item.validation.args;
                }
            }
            item.authorizedInput = structuredClone(item.plan.input) as Record<string, unknown>;
        }

        // Revalidate policy and hook rewrites before any execution begins.
        for (const item of prepared) {
            if (item.blocked || item.validation?.ok === false) {
                continue;
            }
            item.validation = safeValidate(config.tools, item.plan.name, item.plan.input as Record<string, unknown>);
            if (item.validation.ok && !isDeepStrictEqual(item.validation.args, item.authorizedInput)) {
                item.validation = {
                    ok: false, result: {
                        ok: false,
                        content: 'Validation changed authorized arguments',
                        errorKind: 'validation'
                    }
                };
            }
            if (item.validation.ok) {
                item.plan.input = item.validation.args;
            }
        }
    }

    const batchRejected = !independentReads && prepared.some(item => item.validation?.ok === false);
    for (const item of prepared) {
        if (item.validation && !item.validation.ok) {
            item.blocked = {
                callId: item.plan.callId,
                plan: item.plan,
                status: 'runtime_failure',
                dispatched: false,
                result: item.validation.result,
                error: item.validation.result.content,
            };
        }
    }
    const executions: ToolExecution[] = [];
    let interruption: 'abort' | 'steering' | null = null;
    let controlFailure: Failure | undefined;
    let steeringMessages: Message[] = [];

    if (batchRejected) {
        for (const item of prepared) {
            if (item.blocked) {
                executions.push(item.blocked);
            } else {
                executions.push({
                    callId: item.plan.callId,
                    plan: item.plan,
                    status: 'skipped',
                    dispatched: false,
                    error: 'Batch rejected before execution because another tool call was invalid',
                });
            }
        }
        for (const execution of executions) {
            await emit({
                type: 'tool_end',
                turnId,
                callId: execution.callId,
                name: execution.plan.name,
                execution,
            });
        }
    } else {
        for (const item of prepared) {
            if (item.blocked) {
                executions.push(item.blocked);
                await emit({
                    type: 'tool_end',
                    turnId,
                    callId: item.plan.callId,
                    name: item.plan.name,
                    execution: item.blocked
                });
                continue;
            }
            if (signal?.aborted) {
                interruption = 'abort';
                break;
            }
            await emit({
                type: 'tool_start',
                turnId,
                callId: item.plan.callId,
                name: item.plan.name,
                input: structuredClone(item.plan.input)
            });
            if (signal?.aborted) {
                interruption = 'abort';
                break;
            }
            const callStartedAt = Date.now();
            const contextForCall = policyContext(item.plan);
            let result: ToolCallResult;
            try {
                result = await config.tools.call(item.plan.name, contextForCall.args, {
                    callId: item.plan.callId,
                    sessionId: config.sessionId,
                    signal,
                    authorizedArgs: structuredClone(contextForCall.args),
                });
            } catch (error) {
                result = {
                    ok: false,
                    content: `Tool runtime violated call() contract: ${errorMessage(error)}`,
                    errorKind: 'unknown',
                };
            }
            const latencyMs = Date.now() - callStartedAt;
            const rawResult = structuredClone(result);
            let hookFailure: Failure | undefined;
            if (config.afterToolCall) {
                try {
                    result = await config.afterToolCall({
                        ...contextForCall,
                        result: structuredClone(rawResult),
                        latencyMs
                    }) ?? rawResult;
                } catch (error) {
                    result = rawResult;
                    hookFailure = extensionFailure('afterToolCall', error);
                }
            }
            const status: ToolExecution['status'] = rawResult.ok ? 'success'
                : rawResult.errorKind === 'timeout' ? 'timeout'
                : rawResult.errorKind === 'cancelled' ? 'cancelled'
                : rawResult.errorKind === 'unknown' ? 'unknown'
                : 'runtime_failure';
            const execution: ToolExecution = {
                callId: item.plan.callId,
                plan: item.plan,
                status,
                dispatched: true,
                result,
                latencyMs,
                ...(config.afterToolCall ? { rawResult } : {}),
                ...(hookFailure ? { hookFailure } : {}),
                ...(!rawResult.ok ? { error: rawResult.content } : {}),
            };
            executions.push(execution);
            await emit({
                type: 'tool_end',
                turnId,
                callId: item.plan.callId,
                name: item.plan.name,
                execution
            });
            if (status === 'unknown' || status === 'timeout' || status === 'cancelled') {
                controlFailure = { kind: 'tool_outcome_unknown', message: `Tool '${item.plan.name}' outcome is unknown after dispatch; reconcile before continuing` };
                break;
            }
            if (hookFailure) {
                controlFailure = hookFailure;
                break;
            }
            if (signal?.aborted) {
                interruption = 'abort';
                break;
            }
            if (config.getSteeringMessages) {
                let steering: Message[];
                try {
                    steering = await config.getSteeringMessages();
                } catch (error) {
                    controlFailure = extensionFailure('getSteeringMessages', error);
                    break;
                }
                if (steering.length > 0) {
                    interruption = 'steering';
                    steeringMessages = steering;
                    break;
                }
            }
        }
        if (interruption || controlFailure) {
            for (const item of prepared.slice(executions.length)) {
                const execution: ToolExecution = {
                    callId: item.plan.callId,
                    plan: item.plan,
                    status: interruption === 'abort' ? 'cancelled' : 'skipped',
                    dispatched: false,
                    ...(controlFailure ? { error: `Skipped after ${controlFailure.kind}` } : {}),
                };
                executions.push(execution);
                await emit({
                    type: 'tool_end',
                    turnId,
                    callId: item.plan.callId,
                    name: item.plan.name,
                    execution
                });
            }
        }
    }

    return {
        plans: prepared.map(item => item.plan),
        executions,
        interruption,
        steeringMessages,
        ...(controlFailure ? { controlFailure } : {})
    };
}

/** Execute a batch without model calls, transcript writes or synthetic lifecycle events. */
export async function executeToolBatch(calls: ToolCall[], options: ToolBatchOptions): Promise<ToolExecution[]> {
    if (calls.length === 0) {
        return [];
    }
    options.signal?.throwIfAborted();
    return (await executeToolBatchDetailed(calls, options)).executions;
}
