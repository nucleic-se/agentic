import type { ILLMProvider, Message } from '../../contracts/llm.js';
import { createHarnessExecution } from '../../runtime/harness/core.js';
import { budgetedContext } from '../../runtime/harness/context.js';

/** The application keeps its history and owns the provider's lifetime. */
export async function chatReply(
    provider: ILLMProvider,
    history: Message[],
    signal?: AbortSignal,
) {
    const execution = createHarnessExecution({
        provider,
        context: budgetedContext('Answer the user clearly.', 8000),
    });
    return execution.model({ messages: history, maxTokens: 1000 }, { signal });
}
