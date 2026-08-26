import { randomUUID } from 'node:crypto';
import { LLMProtocolError, LLMRequestBudgetError } from '../contracts/llm.js';
import type { ILLMProvider, Message, ToolResultMessage, TurnRequest } from '../contracts/llm.js';
import type {
    AgentEventSink,
    ContextCandidate,
    Failure,
    ToolExecution,
    ToolPlan,
    TurnRecord,
} from '../contracts/agent.js';
import type { IToolPolicy, PolicyContext } from '../contracts/IToolPolicy.js';
import type { IValidatedToolRuntime, ToolCallResult } from '../contracts/tool-runtime.js';

export interface AgentKernelContext {
    system?: string;
    messages: Message[];
    contextUsed?: ContextCandidate[];
}

export interface BeforeKernelToolCallResult {
    action: 'continue' | 'skip';
    args?: Record<string, unknown>;
    reason?: string;
}

export interface AgentKernelConfig {
    provider: ILLMProvider;
    tools: IValidatedToolRuntime;
    policy?: IToolPolicy;
    maxTurns?: number;
    /** Maximum model-proposed calls accepted in one turn. */
    maxToolCallsPerTurn?: number;
    autoStop?: boolean;
    maxToolResultChars?: number;
    getSteeringMessages?: () => Promise<Message[]>;
    getFollowUpMessages?: () => Promise<Message[]>;
    confirmToolCall?: (context: PolicyContext & { reason: string }) => Promise<boolean> | boolean;
    beforeToolCall?: (context: PolicyContext) => Promise<BeforeKernelToolCallResult> | BeforeKernelToolCallResult;
    afterToolCall?: (context: PolicyContext & {
        result: ToolCallResult;
        latencyMs: number;
    }) => Promise<ToolCallResult | void> | ToolCallResult | void;
    beforeModelCall?: (messages: Message[]) => Promise<Message[]> | Message[];
}

interface PreparedCall {
    plan: ToolPlan;
    blocked?: ToolExecution;
    validation?: ReturnType<IValidatedToolRuntime['validate']>;
}

const noopSink: AgentEventSink = () => {};
export const DEFAULT_MAX_TOOL_CALLS_PER_TURN = 16;

function syntheticResult(callId: string, content: string): ToolResultMessage {
    return { role: 'tool_result', toolCallId: callId, content, isError: true };
}

function resultMessage(execution: ToolExecution, maxChars: number): ToolResultMessage {
    const clip = (content: string) => content.length <= maxChars
        ? content
        : `${content.slice(0, maxChars)}\n\n[truncated — ${content.length} chars total]`;
    if (execution.status === 'success') {
        return {
            role: 'tool_result',
            toolCallId: execution.callId,
            content: clip(execution.result?.content ?? 'Tool returned no content'),
        };
    }
    if (execution.status === 'policy_denied') {
        return syntheticResult(execution.callId, `Denied by policy: ${execution.error ?? 'no reason given'}.`);
    }
    return syntheticResult(
        execution.callId,
        clip(execution.result?.content ?? execution.error ?? `Tool call ${execution.status}`),
    );
}

function failureRecord(
    turnId: string,
    startedAt: number,
    request: TurnRequest,
    failure: Failure,
    contextUsed?: ContextCandidate[],
): TurnRecord {
    return {
        turnId,
        userInput: null,
        modelRequest: request,
        modelResponse: { role: 'assistant', content: '' },
        plan: [],
        executions: [],
        outcome: 'failed',
        failure,
        durationMs: Date.now() - startedAt,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        contextUsed,
    };
}

function policyContext(plan: ToolPlan): PolicyContext {
    return {
        callId: plan.callId,
        name: plan.name,
        args: plan.input as Record<string, unknown>,
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
 * Execute a bounded agent loop over a caller-owned conversation.
 *
 * Conversation writes occur only at reconciliation. Every executable call in
 * a proposed batch is authorized and validated before the first call runs.
 */
async function executeAgentKernel(
    conversation: Message[],
    config: AgentKernelConfig,
    getContext: () => Promise<AgentKernelContext> | AgentKernelContext,
    emit: AgentEventSink = noopSink,
    signal?: AbortSignal,
): Promise<TurnRecord[]> {
    const records: TurnRecord[] = [];
    const maxTurns = config.maxTurns ?? 20;
    const maxResultChars = config.maxToolResultChars ?? 4_000;
    const maxToolCalls = config.maxToolCallsPerTurn ?? DEFAULT_MAX_TOOL_CALLS_PER_TURN;
    if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls < 1) {
        throw new RangeError('maxToolCallsPerTurn must be a positive safe integer');
    }

    while (true) {
        if (records.length >= maxTurns) {
            await emit({ type: 'error', failure: {
                kind: 'max_turns_exceeded', message: `Reached turn limit of ${maxTurns}`,
            } });
            return records;
        }
        if (signal?.aborted) {
            await emit({ type: 'error', failure: { kind: 'abort', message: 'Cancelled before turn started' } });
            return records;
        }

        let context: AgentKernelContext;
        try {
            context = await getContext();
        } catch (error) {
            await emit({ type: 'error', failure: {
                kind: 'context_error', message: error instanceof Error ? error.message : String(error),
            } });
            return records;
        }

        const turnId = randomUUID();
        const startedAt = Date.now();
        await emit({ type: 'turn_start', turnId });
        let request: TurnRequest;
        try {
            const messages = config.beforeModelCall
                ? await config.beforeModelCall(context.messages)
                : context.messages;
            request = {
                system: context.system,
                messages,
                tools: config.tools.tools(),
            };
        } catch (error) {
            const failure = extensionFailure('beforeModelCall/tool discovery', error);
            const fallbackRequest: TurnRequest = {
                system: context.system,
                messages: context.messages,
                tools: [],
            };
            const record = failureRecord(turnId, startedAt, fallbackRequest, failure, context.contextUsed);
            records.push(record);
            await emit({ type: 'turn_end', record });
            await emit({ type: 'error', failure });
            return records;
        }

        let response;
        try {
            if (config.provider.streamTurn) {
                let deltaEvents = Promise.resolve();
                response = await config.provider.streamTurn(request, text => {
                    deltaEvents = deltaEvents
                        .then(() => emit({ type: 'message_delta', text }))
                        .then(() => undefined);
                }, { signal });
                await deltaEvents;
            } else {
                response = await config.provider.turn(request, { signal });
            }
        } catch (error) {
            const aborted = signal?.aborted ?? false;
            const failure: Failure = {
                kind: aborted ? 'abort'
                    : error instanceof LLMRequestBudgetError ? 'context_error'
                    : error instanceof LLMProtocolError ? 'llm_protocol_error'
                    : 'llm_transport_error',
                message: error instanceof Error ? error.message : String(error),
            };
            const record = failureRecord(turnId, startedAt, request, failure, context.contextUsed);
            if (error instanceof LLMProtocolError && error.usage) record.tokenUsage = error.usage;
            if (aborted) record.outcome = 'aborted';
            records.push(record);
            await emit({ type: 'turn_end', record });
            await emit({ type: 'error', failure });
            return records;
        }

        await emit({ type: 'message_end', message: response.message });
        if (response.stopReason === 'max_tokens') {
            const failure: Failure = { kind: 'max_tokens_stop', message: 'Model output stopped at the token limit' };
            const record: TurnRecord = {
                turnId, userInput: null, modelRequest: request, modelResponse: response.message,
                plan: [], executions: [], outcome: 'partial', failure,
                durationMs: Date.now() - startedAt, tokenUsage: response.usage,
                contextUsed: context.contextUsed,
            };
            records.push(record);
            await emit({ type: 'turn_end', record });
            await emit({ type: 'error', failure });
            return records;
        }

        if (response.stopReason === 'end_turn' || response.stopReason === 'stop_sequence') {
            conversation.push(response.message);
            const record: TurnRecord = {
                turnId, userInput: null, modelRequest: request, modelResponse: response.message,
                plan: [], executions: [], outcome: 'answered',
                durationMs: Date.now() - startedAt, tokenUsage: response.usage,
                contextUsed: context.contextUsed,
            };
            records.push(record);
            await emit({ type: 'turn_end', record });
            let followUps: Message[] = [];
            if (config.getFollowUpMessages) {
                try {
                    followUps = await config.getFollowUpMessages();
                } catch (error) {
                    const failure = extensionFailure('getFollowUpMessages', error);
                    await emit({ type: 'error', failure });
                    return records;
                }
            }
            if (followUps.length === 0) return records;
            conversation.push(...followUps);
            continue;
        }

        const calls = response.message.toolCalls ?? [];
        const ids = new Set<string>();
        const duplicate = calls.find(call => {
            if (ids.has(call.id)) return true;
            ids.add(call.id);
            return false;
        });
        if (calls.length === 0 || calls.length > maxToolCalls || duplicate) {
            const failure: Failure = {
                kind: 'llm_protocol_error',
                message: calls.length === 0
                    ? 'Provider returned tool_use without tool calls'
                    : calls.length > maxToolCalls
                    ? `Provider returned ${calls.length} tool calls; maximum is ${maxToolCalls}`
                    : `Provider returned duplicate tool call id '${duplicate?.id}'`,
            };
            const record = failureRecord(turnId, startedAt, request, failure, context.contextUsed);
            record.modelResponse = response.message;
            record.tokenUsage = response.usage;
            records.push(record);
            await emit({ type: 'turn_end', record });
            await emit({ type: 'error', failure });
            return records;
        }

        const prepared: PreparedCall[] = calls.map(call => ({ plan: {
            callId: call.id,
            name: call.name,
            input: call.args,
            trustTier: config.tools.trustTierFor?.(call.name) ?? 'standard',
        } }));

        // Raw model arguments must be valid before policy or confirmation sees them.
        for (const item of prepared) {
            item.validation = safeValidate(config.tools, item.plan.name, item.plan.input as Record<string, unknown>);
            if (item.validation.ok) item.plan.input = item.validation.args;
        }

        const rawBatchRejected = prepared.some(item => item.validation?.ok === false);
        if (!rawBatchRejected) {
            // Resolve authorization and call-transform hooks for the whole batch.
            for (const item of prepared) {
                if (config.policy) {
                    let decision;
                    try {
                        decision = await config.policy.evaluate(policyContext(item.plan));
                    } catch (error) {
                        decision = { kind: 'deny' as const, reason:
                            `Policy evaluation failed: ${error instanceof Error ? error.message : String(error)}` };
                    }
                    if (decision.kind === 'deny') {
                        item.blocked = { callId: item.plan.callId, plan: item.plan,
                            status: 'policy_denied', error: decision.reason };
                        continue;
                    }
                    if (decision.kind === 'confirm') {
                        // Confirmation must display the exact arguments that
                        // will execute, including a composed policy rewrite.
                        if (decision.args) item.plan.input = decision.args;
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
                            item.blocked = { callId: item.plan.callId, plan: item.plan,
                                status: 'policy_denied', error: confirmationError
                                    ? `Confirmation failed closed: ${errorMessage(confirmationError)}`
                                    : `Confirmation denied: ${decision.reason}` };
                            continue;
                        }
                    }
                    if (decision.kind === 'rewrite') item.plan.input = decision.args;
                }
                if (config.beforeToolCall) {
                    let hook: BeforeKernelToolCallResult;
                    try {
                        hook = await config.beforeToolCall(policyContext(item.plan));
                    } catch (error) {
                        item.blocked = { callId: item.plan.callId, plan: item.plan,
                            status: 'policy_denied',
                            error: `beforeToolCall failed closed: ${errorMessage(error)}` };
                        continue;
                    }
                    if (hook.action === 'skip') {
                        item.blocked = { callId: item.plan.callId, plan: item.plan,
                            status: 'skipped', error: hook.reason ?? 'Skipped by beforeToolCall hook' };
                        continue;
                    }
                    if (hook.args) item.plan.input = hook.args;
                }
            }

            // Revalidate policy and hook rewrites before any execution begins.
            for (const item of prepared) {
                if (item.blocked) continue;
                item.validation = safeValidate(config.tools, item.plan.name, item.plan.input as Record<string, unknown>);
                if (item.validation.ok) item.plan.input = item.validation.args;
            }
        }

        const batchRejected = prepared.some(item => item.validation?.ok === false);
        const executions: ToolExecution[] = [];
        let interruption: 'abort' | 'steering' | null = null;
        let controlFailure: Failure | undefined;
        let steeringMessages: Message[] = [];

        if (batchRejected) {
            for (const item of prepared) {
                if (item.blocked) executions.push(item.blocked);
                else if (item.validation && !item.validation.ok) executions.push({
                    callId: item.plan.callId, plan: item.plan, status: 'runtime_failure',
                    result: item.validation.result, error: item.validation.result.content,
                });
                else executions.push({
                    callId: item.plan.callId, plan: item.plan, status: 'skipped',
                    error: 'Batch rejected before execution because another tool call was invalid',
                });
            }
            for (const execution of executions) {
                await emit({
                    type: 'tool_end', turnId, callId: execution.callId,
                    name: execution.plan.name, execution,
                });
            }
        } else {
            for (const item of prepared) {
                if (item.blocked) {
                    executions.push(item.blocked);
                    await emit({ type: 'tool_end', turnId, callId: item.plan.callId,
                        name: item.plan.name, execution: item.blocked });
                    continue;
                }
                if (signal?.aborted) { interruption = 'abort'; break; }
                await emit({ type: 'tool_start', turnId, callId: item.plan.callId,
                    name: item.plan.name, input: item.plan.input });
                const callStartedAt = Date.now();
                const contextForCall = policyContext(item.plan);
                let result: ToolCallResult;
                try {
                    result = await config.tools.call(item.plan.name, contextForCall.args, {
                        callId: item.plan.callId, signal,
                    });
                } catch (error) {
                    result = {
                        ok: false,
                        content: `Tool runtime violated call() contract: ${errorMessage(error)}`,
                        errorKind: 'runtime',
                    };
                }
                const latencyMs = Date.now() - callStartedAt;
                if (config.afterToolCall) {
                    try {
                        result = await config.afterToolCall({ ...contextForCall, result, latencyMs }) ?? result;
                    } catch (error) {
                        result = {
                            ok: false,
                            content: `afterToolCall failed after execution: ${errorMessage(error)}`,
                            errorKind: 'runtime',
                        };
                    }
                }
                const status: ToolExecution['status'] = result.ok ? 'success'
                    : result.errorKind === 'timeout' ? 'timeout'
                    : result.errorKind === 'cancelled' ? 'cancelled'
                    : 'runtime_failure';
                const execution: ToolExecution = {
                    callId: item.plan.callId, plan: item.plan, status, result, latencyMs,
                    ...(!result.ok ? { error: result.content } : {}),
                };
                executions.push(execution);
                await emit({ type: 'tool_end', turnId, callId: item.plan.callId,
                    name: item.plan.name, execution });
                if (signal?.aborted) { interruption = 'abort'; break; }
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
                        callId: item.plan.callId, plan: item.plan,
                        status: interruption === 'abort' ? 'cancelled' : 'skipped',
                        ...(controlFailure ? { error: 'Skipped after steering extension failure' } : {}),
                    };
                    executions.push(execution);
                    await emit({ type: 'tool_end', turnId, callId: item.plan.callId,
                        name: item.plan.name, execution });
                }
            }
        }

        conversation.push(response.message, ...executions.map(ex => resultMessage(ex, maxResultChars)));
        if (interruption === 'steering') conversation.push(...steeringMessages);
        const record: TurnRecord = {
            turnId, userInput: null, modelRequest: request, modelResponse: response.message,
            plan: prepared.map(item => item.plan), executions,
            outcome: controlFailure ? 'failed'
                : interruption === 'abort' ? 'aborted'
                : interruption === 'steering' ? 'interrupted' : 'answered',
            ...(controlFailure ? { failure: controlFailure } : {}),
            ...(interruption || controlFailure ? { interrupted: {
                plannedCalls: prepared.map(item => item.plan.callId),
                executedCalls: executions.filter(ex => ex.status === 'success' || ex.status === 'runtime_failure')
                    .map(ex => ex.callId),
                reason: controlFailure ? 'extension_error' : interruption!,
            } } : {}),
            durationMs: Date.now() - startedAt,
            tokenUsage: response.usage,
            contextUsed: context.contextUsed,
        };
        records.push(record);
        await emit({ type: 'turn_end', record });

        if (controlFailure) {
            await emit({ type: 'error', failure: controlFailure });
            return records;
        }

        if (config.autoStop && !interruption
            && executions.every(ex => ex.status === 'success')
            && !response.message.content.trim()) return records;
        if (interruption === 'abort') {
            await emit({ type: 'error', failure: { kind: 'abort', message: 'Cancelled during tool execution' } });
            return records;
        }
    }
}

/**
 * Run the kernel and bracket every invocation with agent lifecycle events.
 * The returned records are the same records included in `agent_end`.
 */
export async function runAgentKernel(
    conversation: Message[],
    config: AgentKernelConfig,
    getContext: () => Promise<AgentKernelContext> | AgentKernelContext,
    emit: AgentEventSink = noopSink,
    signal?: AbortSignal,
): Promise<TurnRecord[]> {
    await emit({ type: 'agent_start' });
    let records: TurnRecord[] = [];
    try {
        records = await executeAgentKernel(conversation, config, getContext, emit, signal);
        return records;
    } finally {
        await emit({ type: 'agent_end', records });
    }
}
