import { describe, expect, it, vi } from 'vitest';
import { executeModelTurn, executeStructuredModel, ModelStreamError } from './ModelExecutor.js';
import type { ModelOutcome } from './ModelExecutor.js';
import { LLMProtocolError } from '../contracts/llm.js';
import type { ILLMProvider, TurnRequest, TurnResponse } from '../contracts/llm.js';
import { LlmGraphNode } from './graph/nodes/LlmGraphNode.js';
import { AgentLlmNode } from './graph/nodes/AgentLlmNode.js';
import { runAgentKernel } from './AgentKernel.js';
import type { GraphContext } from '../contracts/graph/index.js';

const request: TurnRequest = { messages: [{ role: 'user', content: 'hello' }], previousResponseId: 'prior-response' };
const response = (): TurnResponse => ({ message: { role: 'assistant', content: 'answer' }, stopReason: 'end_turn', responseId: 'next-response', usage: { inputTokens: 3, outputTokens: 2 } });
function provider(): ILLMProvider {
    return { turn: vi.fn(async () => response()), structured: vi.fn(async () => ({ value: { answer: 42 } as never, usage: { inputTokens: 3, outputTokens: 2 } })), embed: vi.fn(async () => []) };
}

describe('shared model execution', () => {
    it('awaits immutable decoded-request observations between intent and receipt', async () => {
        const transport = provider(), order: string[] = [];
        transport.turn = async (_request, options) => {
            await options?.onRequest?.({ url: 'https://fixture.invalid', body: { input: ['exact'] } });
            order.push('http');
            return response();
        };
        await executeModelTurn(transport, request, {
            onIntent: () => { order.push('intent'); },
            onRequest: async observation => {
                expect(Object.isFrozen(observation.body)).toBe(true);
                await Promise.resolve(); order.push('request');
            },
            onOutcome: () => { order.push('receipt'); },
        });
        expect(order).toEqual(['intent', 'request', 'http', 'receipt']);
    });
    it('journals immutable request and response receipts once, preserving continuation IDs', async () => {
        const transport = provider();
        const order: string[] = [];
        const original = structuredClone(request);
        transport.turn = vi.fn(async input => { order.push('dispatch'); expect(input.previousResponseId).toBe('prior-response'); input.messages[0].content = 'provider mutation'; return response(); });
        const result = await executeModelTurn(transport, request, {
            operationId: 'operation',
            onIntent: intent => { order.push('intent'); expect(intent.operationId).toBe('operation'); expect(Object.isFrozen(intent.request.messages[0])).toBe(true); },
            onOutcome: outcome => { order.push('receipt'); expect(outcome.dispatched).toBe(true); expect(outcome.outcome).toBe('completed'); },
        });
        expect(order).toEqual(['intent', 'dispatch', 'receipt']);
        expect(request).toEqual(original);
        expect(result.responseId).toBe('next-response');
    });

    it('does not dispatch or write another receipt after intent commit fails', async () => {
        const transport = provider(); const onOutcome = vi.fn();
        await expect(executeModelTurn(transport, request, { onIntent: () => { throw new Error('storage failed'); }, onOutcome })).rejects.toThrow('storage failed');
        expect(transport.turn).not.toHaveBeenCalled(); expect(onOutcome).not.toHaveBeenCalled();
    });

    it('does not relabel a completed model operation when receipt commit fails', async () => {
        const onOutcome = vi.fn(() => { throw new Error('receipt commit failed'); });
        await expect(executeModelTurn(provider(), request, { onOutcome })).rejects.toThrow('receipt commit failed');
        expect(onOutcome).toHaveBeenCalledTimes(1);
        expect(onOutcome.mock.calls[0]?.[0]).toMatchObject({ outcome: 'completed', dispatched: true });
    });

    it('rejects pre-aborted work without hooks and records abort during intent as undispatched', async () => {
        const transport = provider(); const cancelled = new AbortController(); cancelled.abort();
        const onIntent = vi.fn(); const onOutcome = vi.fn();
        await expect(executeModelTurn(transport, request, { signal: cancelled.signal, onIntent, onOutcome })).rejects.toThrow();
        expect(onIntent).not.toHaveBeenCalled(); expect(onOutcome).not.toHaveBeenCalled();
        const duringIntent = new AbortController();
        await expect(executeModelTurn(transport, request, { signal: duringIntent.signal, onIntent: () => duringIntent.abort(), onOutcome })).rejects.toThrow();
        expect(transport.turn).not.toHaveBeenCalled();
        expect(onOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'aborted', dispatched: false }));
    });

    it('commits known completed response even if cancellation arrives as transport returns', async () => {
        const transport = provider(); const controller = new AbortController(); const onOutcome = vi.fn();
        transport.turn = async () => { controller.abort(); return response(); };
        await expect(executeModelTurn(transport, request, { signal: controller.signal, onOutcome })).rejects.toThrow();
        expect(onOutcome).toHaveBeenCalledTimes(1);
        expect(onOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'completed', dispatched: true, usage: { inputTokens: 3, outputTokens: 2 } }));
    });

    it('journals protocol failures with known usage and rejects tool/stop mismatches', async () => {
        const transport = provider(); const onOutcome = vi.fn();
        transport.turn = async () => ({ ...response(), stopReason: 'tool_use' });
        await expect(executeModelTurn(transport, request, { onOutcome })).rejects.toBeInstanceOf(LLMProtocolError);
        expect(onOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', dispatched: true, failure: expect.objectContaining({ kind: 'protocol' }), usage: { inputTokens: 3, outputTokens: 2 } }));
    });

    it('returns partial receipts for loops but rejects them for complete-only consumers', async () => {
        const transport = provider(); transport.turn = async () => ({ ...response(), stopReason: 'max_tokens' });
        expect((await executeModelTurn(transport, request)).stopReason).toBe('max_tokens');
        const onOutcome = vi.fn();
        await expect(executeModelTurn(transport, request, { requireComplete: true, onOutcome })).rejects.toThrow('token limit');
        expect(onOutcome).toHaveBeenCalledTimes(1);
        expect(onOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'partial' }));
    });

    it('serializes asynchronous deltas and isolates observer errors from model receipt truth', async () => {
        const transport = provider(); const seen: string[] = [];
        transport.streamTurn = async (_input, delta) => { delta('a'); delta('b'); return response(); };
        await executeModelTurn(transport, request, { onDelta: async text => { await Promise.resolve(); seen.push(text); } });
        expect(seen).toEqual(['a', 'b']); expect(transport.turn).not.toHaveBeenCalled();
        const onOutcome = vi.fn();
        await expect(executeModelTurn(transport, request, { onDelta: () => { throw new Error('renderer failed'); }, onOutcome })).rejects.toBeInstanceOf(ModelStreamError);
        expect(onOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'completed' }));
    });

    it('bounds streaming observer backlog rather than growing without limit', async () => {
        const transport = provider();
        transport.streamTurn = async (_input, delta) => { for (let i = 0; i < 1100; i++) delta('a'); return response(); };
        await expect(executeModelTurn(transport, request, { onDelta: () => {} })).rejects.toThrow('bounded backlog');
    });

    it('honors an expired deadline before dispatch', async () => {
        const transport = provider();
        await expect(executeModelTurn(transport, request, { deadline: Date.now() - 100 })).rejects.toThrow('deadline');
        expect(transport.turn).not.toHaveBeenCalled();
    });

    it('signals an active deadline and records a dispatched interruption', async () => {
        const transport = provider(); const onOutcome = vi.fn();
        transport.turn = async (_input, options) => new Promise((_resolve, reject) => {
            options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
        });
        await expect(executeModelTurn(transport, request, { deadline: Date.now() + 20, onOutcome })).rejects.toThrow('deadline');
        expect(onOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'aborted', dispatched: true }));
    });

    it('validates structured values with the supplied executable validator', async () => {
        const receipts: ModelOutcome[] = [];
        await expect(executeStructuredModel(provider(), { messages: request.messages, schema: { type: 'object' } }, {
            validateValue: () => { throw new Error('Expected string'); }, onOutcome: receipt => { receipts.push(receipt); },
        })).rejects.toThrow('failed validation');
        expect(receipts).toHaveLength(1); expect(receipts[0]).toMatchObject({ outcome: 'failed', usage: { inputTokens: 3, outputTokens: 2 } });
    });

    it('does not write truncated graph text and still accounts for consumed tokens', async () => {
        const transport = provider(); transport.turn = async () => ({ ...response(), stopReason: 'max_tokens' });
        const state = { answer: 'unchanged' }; const reportTokens = vi.fn();
        const node = new LlmGraphNode({ id: 'answer', provider: transport, prompt: () => ({ instructions: '', text: 'hello' }), outputKey: 'answer' });
        await expect(node.process(state, { signal: new AbortController().signal, reportTokens } as unknown as GraphContext<typeof state>)).rejects.toThrow('token limit');
        expect(state.answer).toBe('unchanged'); expect(reportTokens).toHaveBeenCalledWith(5);
    });

    it('preserves agent-node dynamic-provider retries and accounts for every known attempt', async () => {
        const first = provider(); const fallback = provider();
        first.turn = async () => { throw new LLMProtocolError('retry this malformed response', { usage: { inputTokens: 3, outputTokens: 1 } }); };
        const state = { system: 'initial', messages: request.messages, fallback: false, answer: undefined as unknown };
        const reportTokens = vi.fn();
        const node = new AgentLlmNode<typeof state>({
            id: 'agent', provider: state => state.fallback ? fallback : first,
            systemPromptKey: 'system', messagesKey: 'messages', outputKey: 'answer',
            onError: async (_error, state) => { state.fallback = true; state.system = 'retry prompt'; return 'retry'; },
        });
        await node.process(state, { signal: new AbortController().signal, reportTokens } as unknown as GraphContext<typeof state>);
        expect(fallback.turn).toHaveBeenCalledWith(expect.objectContaining({ system: 'retry prompt' }), expect.anything());
        expect(state.answer).toEqual(response().message);
        expect(reportTokens.mock.calls).toEqual([[4], [5]]);
    });

    it('does not retry agent-node presentation or accounting failures', async () => {
        const transport = provider();
        transport.streamTurn = async (_input, delta) => { delta('text'); return response(); };
        const state = { system: '', messages: request.messages, answer: 'unchanged' };
        const onError = vi.fn(async () => 'retry' as const); const reportTokens = vi.fn();
        const node = new AgentLlmNode<typeof state>({ id: 'agent', provider: transport,
            systemPromptKey: 'system', messagesKey: 'messages', outputKey: 'answer', onError,
            onDelta: () => { throw new Error('renderer broke'); },
        });
        await expect(node.process(state, { signal: new AbortController().signal, reportTokens } as unknown as GraphContext<typeof state>)).rejects.toBeInstanceOf(ModelStreamError);
        expect(onError).not.toHaveBeenCalled(); expect(state.answer).toBe('unchanged');
        expect(reportTokens).toHaveBeenCalledExactlyOnceWith(5);
    });

    it('preserves known kernel receipt and usage when the stream observer fails', async () => {
        const transport = provider(); transport.streamTurn = async (_input, delta) => { delta('text'); return response(); };
        const records = await runAgentKernel([], { provider: transport, tools: { tools: () => [], validate: () => ({ ok: true, args: {} }), call: async () => ({ ok: true, content: '' }) } },
            () => ({ messages: request.messages }), event => { if (event.type === 'message_delta') throw new Error('renderer broke'); });
        expect(records[0].failure?.kind).toBe('extension_error');
        expect(records[0].tokenUsage).toEqual(response().usage);
        expect(records[0].modelResponse).toEqual(response().message);
    });
});
