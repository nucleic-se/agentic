import { presentToolResult } from '../runtime/ToolOutput.js';
import { createHash } from 'node:crypto';
import { ANTHROPIC_MODELS } from '@earendil-works/pi-ai/providers/anthropic.models';
import { stream, type AnthropicEffort, type AnthropicThinkingDisplay } from '@earendil-works/pi-ai/api/anthropic-messages';
import type { AssistantMessage as NativeMessage, Context, Model } from '@earendil-works/pi-ai';
import { LLMProtocolError, type AssistantMessage, type ILLMProvider, type ProviderCallOptions,
    type StructuredRequest, type StructuredResponse, type TurnRequest, type TurnResponse, type TokenUsage,
    type ProviderCapabilities, type ProviderRequestObservation } from '../contracts/llm.js';
import type { JsonValue } from '../contracts/shared.js';
import { createContinuation, readContinuation } from './continuation.js';
import { providerSignal } from './cancellation.js';

export interface AnthropicSubscriptionProviderOptions {
    model: string;
    /** Caller-owned authorized OAuth source. Honor cancellation; this adapter never reads auth files. */
    credentials: (signal?: AbortSignal) => Promise<string>;
    fetch?: typeof fetch;
    thinkingEnabled?: boolean;
    thinkingBudgetTokens?: number;
    effort?: AnthropicEffort;
    thinkingDisplay?: AnthropicThinkingDisplay;
    /** Final decoded request body, after backend normalization; excludes authentication headers. */
    onRequest?: (request: ProviderRequestObservation) => void | Promise<void>;
}

const format = 'anthropic-subscription-annotations/v1';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const zeroUsage: NativeMessage['usage'] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function annotations(content: NativeMessage['content']): JsonValue {
    let index = 0;
    return content.map(block => {
        if (block.type === 'text') return { type: block.type, length: block.text.length,
            ...(block.textSignature === undefined ? {} : { textSignature: block.textSignature }) };
        if (block.type === 'toolCall') return { type: block.type, index: index++,
            ...(block.thoughtSignature === undefined ? {} : { thoughtSignature: block.thoughtSignature }),
            ...(block.namespace === undefined ? {} : { namespace: block.namespace }) };
        return { type: block.type, thinking: block.thinking,
            ...(block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature }),
            ...(block.redacted === undefined ? {} : { redacted: block.redacted }) };
    });
}

/** Generated reasoning is a replay-cost proxy, not measured input occupancy. */
function continuationTokens(message: NativeMessage): number | undefined {
    const visible = Math.ceil(message.content.reduce((total, block) =>
        total + (block.type === 'thinking' ? block.thinking.length : 0), 0) / 4);
    if ((message.usage.reasoning ?? 0) > 0) return Math.max(message.usage.reasoning!, visible);
    // The backend maps missing reasoning usage to zero. Opaque state still has unknown cost.
    const opaque = message.content.some(block => block.type === 'thinking'
        ? block.thinkingSignature || block.redacted
        : block.type === 'toolCall' && block.thoughtSignature);
    return opaque ? undefined : visible;
}

function restore(message: AssistantMessage, data: JsonValue): NativeMessage['content'] {
    const invalid = () => new LLMProtocolError('Invalid Anthropic subscription continuation annotations');
    if (!Array.isArray(data)) throw invalid();
    let offset = 0, callIndex = 0;
    const blocks: NativeMessage['content'] = data.map(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
        const signature = (key: string): string | undefined => {
            if (value[key] !== undefined && typeof value[key] !== 'string') throw invalid();
            return value[key] as string | undefined;
        };
        if (value.type === 'text') {
            const length = value.length;
            if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || offset + length > message.content.length) throw invalid();
            const text = message.content.slice(offset, offset + length); offset += length;
            return { type: 'text', text, textSignature: signature('textSignature') };
        }
        if (value.type === 'toolCall') {
            if (value.index !== callIndex) throw invalid();
            const call = message.toolCalls?.[callIndex++];
            if (!call) throw invalid();
            return { type: 'toolCall', id: call.id, name: call.name, arguments: call.args,
                thoughtSignature: signature('thoughtSignature'), namespace: signature('namespace') };
        }
        if (value.type !== 'thinking' || typeof value.thinking !== 'string' ||
            (value.redacted !== undefined && typeof value.redacted !== 'boolean')) throw invalid();
        return { type: 'thinking', thinking: value.thinking, thinkingSignature: signature('thinkingSignature'), redacted: value.redacted as boolean | undefined };
    });
    if (offset !== message.content.length || callIndex !== (message.toolCalls?.length ?? 0)) throw invalid();
    return blocks;
}

function usage(value: NativeMessage['usage']): TokenUsage {
    for (const count of [value.input, value.output, value.cacheRead, value.cacheWrite, value.totalTokens, ...(value.reasoning === undefined ? [] : [value.reasoning])]) {
        if (!Number.isSafeInteger(count) || count < 0) throw new LLMProtocolError('Invalid Anthropic token usage');
    }
    return { inputTokens: value.input + value.cacheRead + value.cacheWrite, outputTokens: value.output,
        cacheReadTokens: value.cacheRead, cacheWriteTokens: value.cacheWrite,
        ...(value.reasoning === undefined ? {} : { reasoningTokens: value.reasoning }), totalTokens: value.input + value.cacheRead + value.cacheWrite + value.output };
}

/** Native Anthropic tool execution through the optional Pi transport, never Claude Code delegation.
 * Pi's OAuth mode adds Claude Code identity headers and a system prefix. This describes wire
 * behavior, not a claim of official permission for third-party subscription use. */
export class AnthropicSubscriptionProvider implements ILLMProvider {
    readonly capabilities: Readonly<ProviderCapabilities>;
    readonly configurationIdentity: string;
    readonly #options: AnthropicSubscriptionProviderOptions;
    readonly #model: Model<'anthropic-messages'>;
    readonly #identity: string;

    constructor(options: AnthropicSubscriptionProviderOptions) {
        if (!options.model.trim()) throw new Error('A model is required');
        this.#options = { ...options };
        if (typeof options.credentials !== 'function') throw new Error('An authorized credentials callback is required');
        const catalog = ANTHROPIC_MODELS[options.model as keyof typeof ANTHROPIC_MODELS];
        if (!catalog) throw new Error(`Unknown Anthropic subscription model: ${options.model}`);
        if (options.thinkingEnabled !== undefined && typeof options.thinkingEnabled !== 'boolean') {
            throw new Error('thinkingEnabled must be a boolean');
        }
        if (catalog.compat?.supportsMidConvoEffort && options.thinkingEnabled === false) {
            throw new Error('This model requires managed adaptive thinking');
        }
        if (options.thinkingDisplay !== undefined && !['summarized', 'omitted'].includes(options.thinkingDisplay)) {
            throw new Error('Unsupported thinkingDisplay');
        }
        if ((options.effort !== undefined || options.thinkingDisplay !== undefined) && options.thinkingEnabled !== true && !catalog.compat?.supportsMidConvoEffort) {
            throw new Error('effort and thinkingDisplay require enabled thinking');
        }
        if (options.thinkingBudgetTokens !== undefined && (!Number.isSafeInteger(options.thinkingBudgetTokens) || options.thinkingBudgetTokens < 1024)) {
            throw new Error('thinkingBudgetTokens must be an integer of at least 1024');
        }
        if (options.thinkingBudgetTokens !== undefined && (options.thinkingEnabled !== true || catalog.compat?.forceAdaptiveThinking)) {
            throw new Error('thinkingBudgetTokens requires enabled budget-based thinking');
        }
        if (options.effort !== undefined && (!['low', 'medium', 'high', 'xhigh', 'max'].includes(options.effort) || (!catalog.compat?.forceAdaptiveThinking && !catalog.compat?.supportsMidConvoEffort))) {
            throw new Error('effort requires an adaptive-thinking model and a supported effort value');
        }
        this.#model = structuredClone(catalog);
        this.capabilities = Object.freeze({
            transport: 'http-sse', toolBatching: true, outputLimit: 'enforced',
            automaticRetries: 0, continuation: 'message', requestObservation: 'decoded-wire',
            contextWindowTokens: catalog.contextWindow,
        });
        this.#identity = hash([this.#model.provider, this.#model.api, this.#model.id, this.#model.baseUrl]);
        this.configurationIdentity = hash([this.#identity, options.thinkingEnabled ?? null,
            options.thinkingBudgetTokens ?? null, options.effort ?? null, options.thinkingDisplay ?? null]);
    }

    #context(request: TurnRequest): Context {
        const names = new Map(request.messages.flatMap(message => message.role === 'assistant'
            ? (message.toolCalls ?? []).map(call => [call.id, call.name] as const) : []));
        return { systemPrompt: request.system, tools: request.tools as Context['tools'], messages: request.messages.map(message => {
            if (message.role === 'user') return { role: 'user', content: message.content, timestamp: 0 };
            if (message.role === 'tool_result') {
                message = presentToolResult(message);
                return { role: 'toolResult', toolCallId: message.toolCallId,
                toolName: message.toolName ?? names.get(message.toolCallId) ?? '',
                content: message.contentBlocks?.length ? message.contentBlocks : [{ type: 'text', text: message.content }],
                isError: message.isError ?? false, timestamp: 0 };
            }
            const saved = readContinuation(message, format, this.#identity);
            if (saved !== undefined && (!saved || typeof saved !== 'object' || Array.isArray(saved)
                || (saved.model !== undefined && (typeof saved.model !== 'string' || !saved.model.trim()))
                || (saved.providerThinkingLevel !== undefined && (typeof saved.providerThinkingLevel !== 'string' || !['low', 'medium', 'high', 'xhigh', 'max'].includes(saved.providerThinkingLevel))))) {
                throw new LLMProtocolError('Invalid Anthropic subscription continuation metadata');
            }
            const metadata = saved as { content: JsonValue; model?: string; providerThinkingLevel?: string } | undefined;
            const content: NativeMessage['content'] = metadata === undefined
                ? [...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
                    ...(message.toolCalls ?? []).map(call => ({ type: 'toolCall' as const, id: call.id, name: call.name, arguments: call.args }))]
                : restore(message, metadata.content);
            return { role: 'assistant', content, api: this.#model.api, provider: this.#model.provider, model: metadata?.model ?? this.#model.id,
                usage: zeroUsage, ...(metadata?.providerThinkingLevel ? { providerThinkingLevel: metadata.providerThinkingLevel } : {}), stopReason: message.toolCalls?.length ? 'toolUse' : 'stop', timestamp: 0 };
        }) };
    }

    turn(request: TurnRequest, options?: ProviderCallOptions): Promise<TurnResponse> { return this.streamTurn(request, () => {}, options); }
    streamTurn(request: TurnRequest, onDelta: (text: string) => void, options?: ProviderCallOptions): Promise<TurnResponse> {
        return this.#run(request, onDelta, options);
    }

    async #run(request: TurnRequest, onDelta: (text: string) => void, options?: ProviderCallOptions, toolChoice?: 'any'): Promise<TurnResponse> {
        if (request.previousResponseId) throw new Error('Subscription continuation requires explicit message replay');
        if (request.stopSequences?.length) throw new Error('Subscription stop sequences are unsupported');
        if (request.cacheScope !== undefined && !request.cacheScope.trim()) throw new Error('cacheScope must be nonempty');
        if (request.maxTokens !== undefined && (!Number.isSafeInteger(request.maxTokens) || request.maxTokens < 1)) throw new Error('maxTokens must be a positive integer');
        if ((request.maxTokens ?? this.#model.maxTokens) > this.#model.maxTokens) throw new Error('maxTokens exceeds the model output capacity');
        if (this.#options.thinkingEnabled && !this.#model.compat?.forceAdaptiveThinking
            && (this.#options.thinkingBudgetTokens ?? 1024) >= (request.maxTokens ?? this.#model.maxTokens)) {
            throw new Error('Thinking budget must be below maxTokens');
        }
        const context = this.#context(request), controller = new AbortController(), callerSignal = providerSignal(options);
        const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
        signal?.throwIfAborted();
        const fetcher = this.#options.fetch ?? globalThis.fetch;
        const apiKey = await this.#options.credentials(signal);
        signal.throwIfAborted();
        if (!apiKey?.includes('sk-ant-oat')) throw new Error('An authorized Anthropic OAuth access token is required');
        let observationFailed = false;
        let observationError: unknown;
        const events = stream(this.#model, context, {
            apiKey, signal, maxRetries: 0, maxTokens: request.maxTokens, toolChoice,
            thinkingEnabled: this.#options.thinkingEnabled,
            thinkingBudgetTokens: this.#options.thinkingBudgetTokens,
            effort: this.#options.effort,
            thinkingDisplay: this.#options.thinkingDisplay,
            sessionId: request.cacheScope === undefined ? undefined : hash(request.cacheScope),
            fetch: async (url, init) => {
                if ((this.#options.onRequest || options?.onRequest) && init?.body) {
                    const body = typeof init.body === 'string' ? init.body : Buffer.from(init.body as Uint8Array).toString();
                    const observation = { url: String(url), body: JSON.parse(body) as JsonValue };
                    try {
                        await this.#options.onRequest?.(structuredClone(observation));
                        await options?.onRequest?.(structuredClone(observation));
                    } catch (error) {
                        observationFailed = true;
                        observationError = error;
                        throw error;
                    }
                }
                signal.throwIfAborted();
                return fetcher(url, init);
            },
        });
        let native: NativeMessage;
        try {
            for await (const event of events) if (event.type === 'text_delta') onDelta(event.delta);
            native = await events.result();
        } finally { controller.abort(); }
        if (observationFailed) throw observationError;
        const measured = usage(native.usage);
        if (!['stop', 'length', 'toolUse'].includes(native.stopReason)) {
            // The backend initializes usage to zero before any receipt. An error
            // with that default is unknown usage, not evidence of a free request.
            const known = measured.inputTokens + measured.outputTokens > 0;
            const message = native.errorMessage ?? `Provider stopped: ${native.stopReason}`;
            if (!known) throw new Error(message);
            throw new LLMProtocolError(message, { usage: measured });
        }
        const calls = native.content.flatMap(block => block.type === 'toolCall' ? [{ id: block.id, name: block.name, args: block.arguments }] : []);
        if (calls.some(call => !call.id || !call.name || !call.args || typeof call.args !== 'object' || Array.isArray(call.args))) {
            throw new LLMProtocolError('Invalid Anthropic tool call', { usage: measured });
        }
        if ((native.stopReason === 'toolUse' && !calls.length) || (native.stopReason === 'stop' && calls.length)) {
            throw new LLMProtocolError('Anthropic stop reason does not match tool calls', { usage: measured });
        }
        if (new Set(calls.map(call => call.id)).size !== calls.length) throw new LLMProtocolError('Duplicate tool call IDs', { usage: measured });
        const message: AssistantMessage = { role: 'assistant', content: native.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''),
            ...(calls.length ? { toolCalls: calls } : {}) };
        message.continuation = createContinuation(message, format, this.#identity, { content: annotations(native.content), model: native.model,
            ...(native.providerThinkingLevel === undefined ? {} : { providerThinkingLevel: native.providerThinkingLevel }) });
        const estimatedInputTokens = continuationTokens(native);
        if (estimatedInputTokens !== undefined) message.continuation.estimatedInputTokens = estimatedInputTokens;
        return { message, usage: measured, stopReason: native.stopReason === 'toolUse' ? 'tool_use' : native.stopReason === 'length' ? 'max_tokens' : 'end_turn', responseId: native.responseId };
    }

    async structured<T>(request: StructuredRequest, options?: ProviderCallOptions): Promise<StructuredResponse<T>> {
        if (this.#options.thinkingEnabled || this.#model.compat?.supportsMidConvoEffort) {
            throw new Error('Structured forced-tool output is unsupported with enabled thinking');
        }
        const response = await this.#run({ ...request, tools: [{ name: 'structured_output', description: 'Return the requested structured result', parameters: request.schema }] }, () => {}, options, 'any');
        const calls = response.message.toolCalls ?? [];
        if (response.stopReason !== 'tool_use' || calls.length !== 1 || calls[0].name !== 'structured_output') throw new LLMProtocolError('Expected one structured result', { usage: response.usage });
        return { value: calls[0].args as T, usage: response.usage };
    }
}
