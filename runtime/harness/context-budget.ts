import type { ILLMProvider } from '../../contracts/llm.js';

/** Resolve a working ceiling without coupling context selection to a provider backend. */
export function resolveContextBudget(provider: ILLMProvider, requested?: number): number {
    const capacity = provider.capabilities?.contextWindowTokens;
    for (const [name, value] of [['contextWindowTokens', capacity], ['context token budget', requested]] as const) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
            throw new RangeError(`${name} must be a positive safe integer`);
    }
    if (capacity === undefined && requested === undefined)
        throw new Error('Provider context capacity is unknown; configure an explicit context token budget');
    return Math.min(capacity ?? Infinity, requested ?? Infinity);
}
