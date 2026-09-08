import { presentToolResult } from '../runtime/ToolOutput.js';
import { createHash } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import { stream } from '@earendil-works/pi-ai/api/openai-codex-responses';
import type { AssistantMessage as NativeMessage, Context, Model } from '@earendil-works/pi-ai';
import { openaiCredentials } from '@openai-oauth/local';
import { LLMProtocolError, type AssistantMessage, type ILLMProvider, type ProviderCallOptions,
    type StructuredRequest, type StructuredResponse, type TurnRequest, type TurnResponse, type TokenUsage,
    type ProviderCapabilities, type ProviderRequestObservation } from '../contracts/llm.js';
import type { JsonValue } from '../contracts/shared.js';
import { createContinuation, readContinuation } from './continuation.js';
import { providerSignal } from './cancellation.js';

export interface SubscriptionProviderOptions {
    model: string;
    authFilePath?: string;
    /** Alternative authorized credential source; honor the supplied cancellation signal. */
    credentials?: (signal?: AbortSignal) => Promise<string>;
    baseUrl?: string;
    fetch?: typeof fetch;
    reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
    /** Exact decoded JSON sent over HTTP, after backend normalization. No auth headers. */
    onRequest?: (request: ProviderRequestObservation) => void | Promise<void>;
}

const format = 'subscription-annotations/v1';
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

function restore(message: AssistantMessage, data: JsonValue): NativeMessage['content'] {
    const invalid = () => new LLMProtocolError('Invalid subscription continuation annotations');
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
    return { inputTokens: value.input + value.cacheRead + value.cacheWrite, outputTokens: value.output,
        cacheReadTokens: value.cacheRead, cacheWriteTokens: value.cacheWrite,
        ...(value.reasoning === undefined ? {} : { reasoningTokens: value.reasoning }), totalTokens: value.totalTokens };
}

/** Optional subscription backend. Requires Node >=22.19 and its optional provider dependency. */
export class SubscriptionProvider implements ILLMProvider {
    readonly capabilities = Object.freeze({ transport: 'http-sse', toolBatching: true,
        outputLimit: 'advisory', automaticRetries: 0, continuation: 'message', requestObservation: 'decoded-wire' } as const satisfies ProviderCapabilities);
    readonly #options: SubscriptionProviderOptions;
    readonly #model: Model<'openai-codex-responses'>;
    readonly #identity: string;

    constructor(options: SubscriptionProviderOptions) {
        if (!options.model.trim()) throw new Error('A model is required');
        this.#options = { ...options };
        this.#model = { id: options.model, name: options.model, provider: 'openai-codex', api: 'openai-codex-responses',
            baseUrl: options.baseUrl ?? 'https://chatgpt.com/backend-api', reasoning: true, input: ['text', 'image'],
            // Direct stream uses caller limits; these catalog fields are not admission policy.
            contextWindow: 0, maxTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
        this.#identity = hash([this.#model.provider, this.#model.api, this.#model.id, this.#model.baseUrl]);
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
            const content: NativeMessage['content'] = saved === undefined
                ? [...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
                    ...(message.toolCalls ?? []).map(call => ({ type: 'toolCall' as const, id: call.id, name: call.name, arguments: call.args }))]
                : restore(message, saved);
            return { role: 'assistant', content, api: this.#model.api, provider: this.#model.provider, model: this.#model.id,
                usage: zeroUsage, stopReason: message.toolCalls?.length ? 'toolUse' : 'stop', timestamp: 0 };
        }) };
    }

    turn(request: TurnRequest, options?: ProviderCallOptions): Promise<TurnResponse> { return this.streamTurn(request, () => {}, options); }
    streamTurn(request: TurnRequest, onDelta: (text: string) => void, options?: ProviderCallOptions): Promise<TurnResponse> {
        return this.#run(request, onDelta, options);
    }

    async #run(request: TurnRequest, onDelta: (text: string) => void, options?: ProviderCallOptions, toolChoice?: 'required'): Promise<TurnResponse> {
        if (request.previousResponseId) throw new Error('Subscription continuation requires explicit message replay');
        if (request.stopSequences?.length) throw new Error('Subscription stop sequences are unsupported');
        if (request.cacheScope !== undefined && !request.cacheScope.trim()) throw new Error('cacheScope must be nonempty');
        if (request.maxTokens !== undefined && (!Number.isSafeInteger(request.maxTokens) || request.maxTokens < 1)) throw new Error('maxTokens must be a positive integer');
        const context = this.#context(request), controller = new AbortController(), callerSignal = providerSignal(options);
        const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
        signal?.throwIfAborted();
        const fetcher = this.#options.fetch ?? globalThis.fetch;
        const apiKey = this.#options.credentials ? await this.#options.credentials(signal) :
            (await openaiCredentials({ authFilePath: this.#options.authFilePath,
                fetch: (url, init) => fetcher(url, { ...init, signal }) }).getSession())?.accessToken;
        signal?.throwIfAborted();
        if (!apiKey) throw new Error('No authorized subscription session');
        const events = stream(this.#model, context, { apiKey, signal, transport: 'sse', maxRetries: 0,
            maxTokens: request.maxTokens, reasoningEffort: this.#options.reasoningEffort ?? 'low', toolChoice,
            sessionId: request.cacheScope === undefined ? undefined : hash(request.cacheScope),
            fetch: async (url, init) => {
                if ((this.#options.onRequest || options?.onRequest) && init?.body) {
                    const bytes = typeof init.body === 'string' ? Buffer.from(init.body) : Buffer.from(init.body as Uint8Array);
                    const decoded = new Headers(init.headers).get('content-encoding') === 'zstd' ? zstdDecompressSync(bytes) : bytes;
                    const observation = { url: String(url), body: JSON.parse(decoded.toString()) as JsonValue };
                    await this.#options.onRequest?.(structuredClone(observation));
                    await options?.onRequest?.(structuredClone(observation));
                }
                signal?.throwIfAborted();
                return fetcher(url, init);
            } });
        let native: NativeMessage;
        try {
            for await (const event of events) if (event.type === 'text_delta') onDelta(event.delta);
            native = await events.result();
        } finally { controller.abort(); }
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
        if (new Set(calls.map(call => call.id)).size !== calls.length) throw new LLMProtocolError('Duplicate tool call IDs', { usage: measured });
        const message: AssistantMessage = { role: 'assistant', content: native.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''),
            ...(calls.length ? { toolCalls: calls } : {}) };
        message.continuation = createContinuation(message, format, this.#identity, annotations(native.content));
        return { message, usage: measured, stopReason: native.stopReason === 'toolUse' ? 'tool_use' : native.stopReason === 'length' ? 'max_tokens' : 'end_turn', responseId: native.responseId };
    }

    async structured<T>(request: StructuredRequest, options?: ProviderCallOptions): Promise<StructuredResponse<T>> {
        const response = await this.#run({ ...request, tools: [{ name: 'structured_output', description: 'Return the requested structured result', parameters: request.schema }] }, () => {}, options, 'required');
        const calls = response.message.toolCalls ?? [];
        if (response.stopReason !== 'tool_use' || calls.length !== 1 || calls[0].name !== 'structured_output') throw new LLMProtocolError('Expected one structured result', { usage: response.usage });
        return { value: calls[0].args as T, usage: response.usage };
    }
}
