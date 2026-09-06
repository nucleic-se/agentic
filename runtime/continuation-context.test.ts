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
