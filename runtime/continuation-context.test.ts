import { expect, it } from 'vitest';
import { composeAgentContext, estimateContextTokens } from './ContextPipeline.js';
import { createContinuation } from '../providers/continuation.js';
import type { AssistantMessage } from '../contracts/llm.js';

it('budgets continuation and preserves it atomically with its message', async () => {
    const message: AssistantMessage = { role: 'assistant', content: 'Done' };
    const plain = estimateContextTokens({ messages: [message] }).totalTokens;
    message.continuation = createContinuation(message, 'fixture/v1', 'backend', { opaque: 'x'.repeat(1000) });
    const measured = estimateContextTokens({ messages: [message] }).totalTokens;
    expect(measured).toBeGreaterThan(plain + 200);
    const kept = await composeAgentContext({ messages: [message], tokenBudget: measured });
    expect(kept.messages).toEqual([message]);
    const dropped = await composeAgentContext({ messages: [message], tokenBudget: plain }, { minRecentGroups: 0 });
    expect(dropped.messages).toEqual([]);
    expect(message.continuation.data).toEqual({ opaque: 'x'.repeat(1000) });
});

it.each([0, 37])('counts the adapter estimate %i without changing replay state', async tokens => {
    const message: AssistantMessage = { role: 'assistant', content: 'Done' };
    const plain = estimateContextTokens({ messages: [message] }).totalTokens;
    message.continuation = { ...createContinuation(message, 'fixture/v1', 'backend', { signature: 'x'.repeat(10000) }), estimatedInputTokens: tokens };
    const restored = JSON.parse(JSON.stringify(message));
    expect(estimateContextTokens({ messages: [restored] }).totalTokens).toBe(plain + tokens);
    const context = await composeAgentContext({ messages: [restored], tokenBudget: plain + tokens });
    expect(context.messages).toEqual([message]);
});

it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid continuation estimate %s', tokens => {
    const message: AssistantMessage = { role: 'assistant', content: 'Done' };
    message.continuation = { ...createContinuation(message, 'fixture/v1', 'backend', {}), estimatedInputTokens: tokens };
    expect(() => estimateContextTokens({ messages: [message] })).toThrow('continuation.estimatedInputTokens');
});
