import { randomUUID } from 'node:crypto';
import { LLMProtocolError, LLMRequestBudgetError } from '../contracts/llm.js';
import type { ILLMProvider, Message, ToolResultMessage, TurnRequest, TurnResponse } from '../contracts/llm.js';
import type {
    AgentEventSink,
    ContextCandidate,
    Failure,
    ToolExecution,
    TurnRecord,
} from '../contracts/agent.js';
import { DEFAULT_MAX_TOOL_CALLS_PER_TURN, executeToolBatchDetailed } from './ToolBatchExecutor.js';
import type { ToolBatchConfig } from './ToolBatchExecutor.js';
import { executeModelTurn, ModelStreamError } from './ModelExecutor.js';
export { DEFAULT_MAX_TOOL_CALLS_PER_TURN } from './ToolBatchExecutor.js';
export type { BeforeToolCallResult as BeforeKernelToolCallResult } from './ToolBatchExecutor.js';

export interface AgentKernelContext {
    system?: string;
    messages: Message[];
    contextUsed?: ContextCandidate[];
}

export interface AgentKernelConfig extends ToolBatchConfig {
    provider: ILLMProvider;
    maxTurns?: number;
    autoStop?: boolean;
    maxToolResultChars?: number;
    getSteeringMessages?: () => Promise<Message[]>;
    getFollowUpMessages?: () => Promise<Message[]>;
    beforeModelCall?: (messages: Message[]) => Promise<Message[]> | Message[];
}

const noopSink: AgentEventSink = () => {};

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
            ...(execution.result?.contentBlocks ? { contentBlocks: structuredClone(execution.result.contentBlocks) } : {}),
        };
    }
    if (execution.status === 'policy_denied') {
        return syntheticResult(execution.callId, `Denied by policy: ${execution.error ?? 'no reason given'}.`);
    }
    const result = syntheticResult(
        execution.callId,
        clip(execution.result?.content ?? execution.error ?? `Tool call ${execution.status}`),
    );
    if (execution.status === 'runtime_failure' && execution.result?.contentBlocks) {
        result.contentBlocks = structuredClone(execution.result.contentBlocks);
    }
    return result;
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

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function extensionFailure(extension: string, error: unknown): Failure {
    return { kind: 'extension_error', message: `${extension} failed: ${errorMessage(error)}` };
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
    if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new RangeError('maxTurns must be a positive safe integer');
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
                messages: structuredClone(messages),
                tools: structuredClone(config.tools.tools()),
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
        let received: TurnResponse | undefined;
        try {
            response = await executeModelTurn(config.provider, request, {
                signal, stream: true, operationId: turnId,
                onDelta: text => emit({ type: 'message_delta', text }),
                onOutcome: outcome => { if ('response' in outcome) received = outcome.response; },
            });
        } catch (error) {
            const aborted = signal?.aborted ?? false;
            const failure: Failure = {
                kind: aborted ? 'abort'
                    : error instanceof LLMRequestBudgetError ? 'context_error'
                    : error instanceof LLMProtocolError ? 'llm_protocol_error'
                    : error instanceof ModelStreamError ? 'extension_error'
                    : 'llm_transport_error',
                message: error instanceof Error ? error.message : String(error),
            };
            const record = failureRecord(turnId, startedAt, request, failure, context.contextUsed);
            if (error instanceof LLMProtocolError && error.usage) record.tokenUsage = error.usage;
            if (received) { record.modelResponse = received.message; record.tokenUsage = received.usage; }
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

        const { plans, executions, interruption, steeringMessages, controlFailure } = await executeToolBatchDetailed(calls, {
            ...config, turnId, signal, emit,
        });

        conversation.push(response.message, ...executions.map(ex => resultMessage(ex, maxResultChars)));
        if (interruption === 'steering') conversation.push(...steeringMessages);
        const record: TurnRecord = {
            turnId, userInput: null, modelRequest: request, modelResponse: response.message,
            plan: plans, executions,
            outcome: controlFailure ? 'failed'
                : interruption === 'abort' ? 'aborted'
                : interruption === 'steering' ? 'interrupted' : 'answered',
            ...(controlFailure ? { failure: controlFailure } : {}),
            ...(interruption || controlFailure ? { interrupted: {
                plannedCalls: plans.map(plan => plan.callId),
                executedCalls: executions.filter(ex => ex.dispatched === true)
                    .map(ex => ex.callId),
                reason: controlFailure ? (controlFailure.kind === 'tool_outcome_unknown' ? 'tool_outcome_unknown' : 'extension_error') : interruption!,
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
