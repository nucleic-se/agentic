import type { ProviderCallOptions } from '../contracts/llm.js';

/** Build the effective signal for a provider call without owning caller state. */
export function providerSignal(options?: ProviderCallOptions): AbortSignal | undefined {
    const signals: AbortSignal[] = [];
    if (options?.signal) signals.push(options.signal);
    if (options?.deadline != null) {
        const remaining = Math.max(0, options.deadline - Date.now());
        signals.push(AbortSignal.timeout(remaining));
    }
    if (signals.length === 0) return undefined;
    if (signals.length === 1) return signals[0];
    return AbortSignal.any(signals);
}
