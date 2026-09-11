import type { ILLMProvider } from '../../contracts/llm.js';
import { createDefaultAgent } from '../../runtime/harness/coding-index.js';

/** The preset owns its tools/store; the application retains its provider. */
export async function reviewProject(provider: ILLMProvider, workspace: string, objective: string) {
    const agent = await createDefaultAgent({
        workspace,
        provider,
        tokenBudget: 16000,
        readOnly: true,
    });
    try {
        const session = await agent.create('Project review');
        await agent.submit(session.id, objective, { commandId: 'review' });
        const result = await agent.wait(session.id);
        if (result.status !== 'idle') throw new Error(result.error ?? result.status);
        return result;
    } finally {
        await agent.close();
    }
}
