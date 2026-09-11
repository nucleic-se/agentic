import type { Message } from '../../contracts/llm.js';
import { composeAgentContext, type ContextCompositionOptions } from '../ContextPipeline.js';
import type { ContextStrategy } from './types.js';

export function fullHistoryContext(system = ''): ContextStrategy {
    return {
        async assemble(messages, signal, options) {
            signal.throwIfAborted();
            return {
                system: options?.system ?? system,
                messages: structuredClone(messages),
            };
        },
    };
}

export function budgetedContext(
    system: string | ((messages: readonly Message[], signal: AbortSignal) => Promise<string>),
    tokenBudget: number,
    policy: ContextCompositionOptions = {},
): ContextStrategy {
    if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1) throw new RangeError('tokenBudget must be a positive safe integer');
    return {
        async assemble(messages, signal, options) {
            signal.throwIfAborted();
            if (options?.tokenBudget !== undefined && (!Number.isSafeInteger(options.tokenBudget) || options.tokenBudget < 1)) {
                throw new RangeError('tokenBudget must be a positive safe integer');
            }
            const currentSystem = options?.system ?? (typeof system === 'function' ? await system(messages, signal) : system);
            const result = await composeAgentContext({
                messages,
                system: currentSystem,
                signal,
                ...options,
                tokenBudget: Math.min(tokenBudget, options?.tokenBudget ?? tokenBudget),
            }, {
                protectUserMessages: 'all',
                ...policy,
            });
            signal.throwIfAborted();
            return {
                system: result.system,
                messages: result.messages,
                report: {
                    tokenBudget: result.tokenBudget,
                    usage: result.usage,
                    decisions: result.decisions,
                    systemSections: result.systemSections,
                },
            };
        },
    };
}
