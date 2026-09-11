import { executionSignal } from './ExecutionOptions.js';
import { randomUUID } from 'node:crypto';
import { LLMProtocolError, LLMRequestBudgetError } from '../contracts/llm.js';
import type { ILLMProvider, ProviderCallOptions, StructuredRequest, StructuredResponse, TokenUsage, TurnRequest, TurnResponse } from '../contracts/llm.js';

export interface ModelIntent<Request = TurnRequest | StructuredRequest> {
    operationId: string;
    kind: 'turn' | 'structured';
    request: Request;
    startedAt: number;
}
export interface ModelFailure {
    kind: 'protocol' | 'request_budget' | 'transport' | 'abort' | 'validation' | 'stream';
    message: string;
}
export type ModelOutcome<Response = TurnResponse | StructuredResponse<unknown>> = {
    operationId: string;
    kind: 'turn' | 'structured';
    startedAt: number;
    durationMs: number;
    dispatched: boolean;
} & (
    | { outcome: 'completed' | 'partial'; response: Response; usage: TokenUsage }
    | { outcome: 'failed' | 'aborted'; failure: ModelFailure; usage?: TokenUsage }
);
export interface ModelExecutionOptions<Request, Response> extends ProviderCallOptions {
    operationId?: string;
    /** Awaited before transport. Receives an independent frozen request snapshot. */
    onIntent?(intent: ModelIntent<Request>): void | Promise<void>;
    /** Awaited once before return. Receipt commit failures never generate a second failed receipt. */
    onOutcome?(outcome: ModelOutcome<Response>): void | Promise<void>;
    /** Record truncated output as partial, then reject instead of returning it. */
    requireComplete?: boolean;
}
export interface ModelTurnOptions extends ModelExecutionOptions<TurnRequest, TurnResponse> {
    /** Defaults to true when onDelta is supplied; falls back to turn if streaming is absent. */
    stream?: boolean;
    onDelta?(text: string): void | Promise<void>;
    /** Text-only consumers can explicitly reject model tool calls. */
    allowToolCalls?: boolean;
}
export interface StructuredModelOptions<T> extends ModelExecutionOptions<StructuredRequest, StructuredResponse<T>> {
    /** Optional executable schema validation. JSON Schema alone is not runtime validation. */
    validateValue?(value: unknown): T;
}

/** A presentation observer failed; the model response may still have been committed. */
export class ModelStreamError extends Error {
    constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'ModelStreamError'; }
}

function snapshot<T>(value: T): T {
    const copy = structuredClone(value);
    const visited = new WeakSet<object>();
    const freeze = (item: unknown): void => {
        if (item === null || typeof item !== 'object' || visited.has(item)) return;
        visited.add(item);
        for (const child of Object.values(item)) freeze(child);
        Object.freeze(item);
    };
    freeze(copy);
    return copy;
}
function usage(value: unknown): asserts value is TokenUsage {
    if (!value || typeof value !== 'object') throw new LLMProtocolError('Model response is missing token usage');
    const record = value as Record<string, unknown>;
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens', 'costUsd']) {
        const amount = record[key];
        if (amount === undefined && key !== 'inputTokens' && key !== 'outputTokens') continue;
        if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) throw new LLMProtocolError(`Model returned invalid ${key}`);
    }
}
function validateTurn(response: TurnResponse, allowTools: boolean): void {
    if (!response || typeof response !== 'object') throw new LLMProtocolError('Model returned no response');
    usage(response.usage);
    const invalid = (message: string): never => { throw new LLMProtocolError(message, { usage: response.usage }); };
    if (!response.message || response.message.role !== 'assistant' || typeof response.message.content !== 'string') invalid('Model returned an invalid assistant message');
    if (!['end_turn', 'stop_sequence', 'tool_use', 'max_tokens'].includes(response.stopReason)) invalid('Model returned an invalid stop reason');
    // Partial tool arguments are never executable; preserve the receipt for diagnostics.
    if (response.stopReason === 'max_tokens') return;
    const calls = response.message.toolCalls ?? [];
    if (!Array.isArray(calls)) invalid('Model tool calls must be an array');
    if ((response.stopReason === 'tool_use') !== (calls.length > 0)) invalid('Model tool calls do not match its stop reason');
    if (!allowTools && calls.length) invalid('Model returned tool calls to a text-only operation');
    const ids = new Set<string>();
    for (const call of calls) {
        if (!call || typeof call.id !== 'string' || !call.id || typeof call.name !== 'string' || !call.name || !call.args || typeof call.args !== 'object' || Array.isArray(call.args)) invalid('Model returned an invalid tool call');
        if (ids.has(call.id)) invalid(`Model returned duplicate tool call id '${call.id}'`);
        ids.add(call.id);
    }
}
function failure(error: unknown, aborted: boolean): ModelFailure {
    let kind: ModelFailure['kind'];
    if (aborted) {
        kind = 'abort';
    } else if (error instanceof LLMProtocolError) {
        kind = 'protocol';
    } else if (error instanceof LLMRequestBudgetError) {
        kind = 'request_budget';
    } else if (error instanceof ModelStreamError) {
        kind = 'stream';
    } else {
        kind = 'transport';
    }
    return {
        kind,
        message: error instanceof Error ? error.message : String(error),
    };
}

async function execute<Request, Response extends { usage: TokenUsage }>(
    kind: 'turn' | 'structured', request: Request,
    options: ModelExecutionOptions<Request, Response>,
    dispatch: (request: Request, options: ProviderCallOptions) => Promise<Response>,
    validate: (response: Response) => void,
    partial: (response: Response) => boolean,
): Promise<Response> {
    const { signal, dispose } = executionSignal(options);
    try {
        signal.throwIfAborted();
        const intent: ModelIntent<Request> = { operationId: options.operationId ?? randomUUID(), kind, request: snapshot(request), startedAt: Date.now() };
        // A failed intent commit prevents dispatch and is not a model failure.
        await options.onIntent?.(snapshot(intent));
        let dispatched = false;
        let response: Response;
        try {
            signal.throwIfAborted();
            dispatched = true;
            response = await dispatch(structuredClone(intent.request), { signal, ...(options.deadline !== undefined ? { deadline: options.deadline } : {}),
                ...(options.onRequest ? { onRequest: request => options.onRequest!(snapshot(request)) } : {}) });
            validate(response);
        } catch (error) {
            const knownUsage = error instanceof LLMProtocolError ? error.usage : undefined;
            await options.onOutcome?.(snapshot({ operationId: intent.operationId, kind, startedAt: intent.startedAt,
                durationMs: Date.now() - intent.startedAt, dispatched,
                outcome: signal.aborted ? 'aborted' : 'failed', failure: failure(error, signal.aborted),
                ...(knownUsage ? { usage: knownUsage } : {}) }));
            throw error;
        }
        // Receipt truth is recorded even when cancellation arrives after provider completion.
        const isPartial = partial(response);
        await options.onOutcome?.(snapshot({ operationId: intent.operationId, kind, startedAt: intent.startedAt,
            durationMs: Date.now() - intent.startedAt, dispatched, outcome: isPartial ? 'partial' : 'completed',
            response, usage: response.usage }));
        signal.throwIfAborted();
        if (isPartial && options.requireComplete) throw new LLMProtocolError('Model output reached its token limit', { usage: response.usage });
        return response;
    } finally { dispose(); }
}

/** One model operation; no session, conversation, loop, policy or tool dispatch ownership. */
export async function executeModelTurn(provider: ILLMProvider, request: TurnRequest, options: ModelTurnOptions = {}): Promise<TurnResponse> {
    let deltaTail = Promise.resolve();
    let observerError: ModelStreamError | undefined;
    let pending = 0, pendingChars = 0;
    let accepting = true;
    const delta = (text: string) => {
        if (!accepting || observerError || !options.onDelta) return;
        if (typeof text !== 'string') { observerError = new ModelStreamError('Model stream delta must be text'); return; }
        if (pending >= 1024 || pendingChars + text.length > 262144) { observerError = new ModelStreamError('Model stream observer exceeded its bounded backlog'); return; }
        pending++; pendingChars += text.length;
        deltaTail = deltaTail.then(async () => {
            if (!observerError) await options.onDelta!(text);
        }).catch(error => { observerError ??= new ModelStreamError('Model stream observer failed', { cause: error }); })
            .finally(() => { pending--; pendingChars -= text.length; });
    };
    try {
        const response = await execute('turn', request, options, async (input, callOptions) => {
            try {
                return (options.stream ?? Boolean(options.onDelta)) && provider.streamTurn
                    ? await provider.streamTurn(input, delta, callOptions)
                    : await provider.turn(input, callOptions);
            } finally { accepting = false; await deltaTail; }
        }, response => validateTurn(response, options.allowToolCalls ?? true), response => response.stopReason === 'max_tokens');
        if (observerError) throw observerError;
        return response;
    } finally { accepting = false; }
}

/** Structured model operation with an optional executable value validator. */
export function executeStructuredModel<T = unknown>(provider: ILLMProvider, request: StructuredRequest, options: StructuredModelOptions<T> = {}): Promise<StructuredResponse<T>> {
    return execute('structured', request, options,
        (input, callOptions) => provider.structured<T>(input, callOptions),
        response => {
            if (!response || typeof response !== 'object') throw new LLMProtocolError('Model returned no structured response');
            usage(response.usage);
            if (!Object.prototype.hasOwnProperty.call(response, 'value')) throw new LLMProtocolError('Model returned no structured value', { usage: response.usage });
            if (options.validateValue) {
                try { response.value = options.validateValue(structuredClone(response.value)); }
                catch (error) { throw new LLMProtocolError('Structured model value failed validation', { cause: error, usage: response.usage }); }
            }
        }, () => false);
}
