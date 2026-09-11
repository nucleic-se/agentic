import type { LoopServices, LoopStrategy } from './types.js';

async function drain(services: LoopServices, mode: 'steer' | 'enqueue'): Promise<boolean> {
    const messages = await services.takeQueued(mode);
    return messages.length > 0;
}

export function conversationalLoop(options: { maxTurns?: number; maxTokens?: number } = {}): LoopStrategy {
    const maxTurns = options.maxTurns ?? 20;
    if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new RangeError('maxTurns must be a positive safe integer');
    if (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1)) throw new RangeError('maxTokens must be a positive safe integer');
    return {
        async run(services) {
            for (let turn = 0; turn < maxTurns; turn++) {
                services.signal.throwIfAborted();
                await drain(services, 'steer');
                const response = await services.model.request({
                    ...await services.context(),
                    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
                });
                if (response.stopReason === 'max_tokens') throw new Error('Model output reached its token limit');
                const calls = response.message.toolCalls ?? [];
                if (response.stopReason === 'tool_use' && !calls.length) throw new Error('Model requested tools without tool calls');
                if (response.stopReason !== 'tool_use' && calls.length) throw new Error('Model returned tool calls with an incompatible stop reason');
                if (new Set(calls.map(call => call.id)).size !== calls.length) throw new Error('Model returned duplicate tool call IDs');
                if (response.stopReason === 'tool_use') {
                    // Effect services commit their transcript projections atomically.
                    await services.tools.executeBatch(calls);
                    continue;
                }
                if (await drain(services, 'steer')) continue;
                if (await drain(services, 'enqueue')) continue;
                return;
            }
            throw new Error(`Reached turn limit of ${maxTurns}`);
        },
    };
}

/** An explicit planning model operation precedes the ordinary tool-capable loop. */
export function planningLoop(options: { maxTurns?: number; maxTokens?: number } = {}): LoopStrategy {
    const conversation = conversationalLoop(options);
    return {
        async run(services) {
            services.signal.throwIfAborted();
            await drain(services, 'steer');
            const context = await services.context();
            const plan = await services.model.request({
                ...context,
                tools: [],
                ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
                system: `${context.system ?? ''}\nProduce a concise plan for the user's task. Do not execute tools. A subsequent step will carry out the plan.`,
            });
            if (plan.stopReason === 'max_tokens' || plan.stopReason === 'tool_use' || plan.message.toolCalls?.length) {
                throw new Error('Planning response must be complete and contain no tool calls');
            }
            await conversation.run(services);
        },
    };
}
