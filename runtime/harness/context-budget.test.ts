import { expect, it, vi } from 'vitest';
import { resolveContextBudget } from './context-budget.js';
import type { ILLMProvider, ProviderCapabilities } from '../../contracts/llm.js';
import { SubscriptionProvider } from '../../providers/subscription.js';

function provider(capacity?: number): ILLMProvider {
    return { turn: vi.fn(), structured: vi.fn(), capabilities: {
        transport: 'test', toolBatching: true, outputLimit: 'enforced', automaticRetries: 0,
        continuation: 'none', requestObservation: 'none', contextWindowTokens: capacity,
    } satisfies ProviderCapabilities };
}

it('uses known model capacity and only permits explicit caps to narrow it', () => {
    const model = provider(100000);
    expect(resolveContextBudget(model)).toBe(100000);
    expect(resolveContextBudget(model, 24000)).toBe(24000);
    expect(resolveContextBudget(model, 200000)).toBe(100000);
    expect(model.turn).not.toHaveBeenCalled();
});

it('requires an explicit bound when model capacity is unknown', () => {
    expect(() => resolveContextBudget(provider())).toThrow('capacity is unknown');
    expect(resolveContextBudget(provider(), 16000)).toBe(16000);
});

it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid capacities even when another bound is valid (%s)', invalid => {
    expect(() => resolveContextBudget(provider(invalid), 1000)).toThrow('positive safe integer');
    expect(() => resolveContextBudget(provider(1000), invalid)).toThrow('positive safe integer');
});

it('keeps subscription catalog knowledge behind the provider contract', () => {
    const known = new SubscriptionProvider({ model: 'gpt-5.6-sol' });
    expect(known.capabilities.contextWindowTokens).toBeGreaterThan(24000);
    expect(Object.isFrozen(known.capabilities)).toBe(true);
    expect(new SubscriptionProvider({ model: 'unknown-model' }).capabilities.contextWindowTokens).toBeUndefined();
    expect(new SubscriptionProvider({ model: 'gpt-5.6-sol', baseUrl: 'https://custom.example' }).capabilities.contextWindowTokens).toBeUndefined();
    expect(new SubscriptionProvider({ model: 'gpt-5.6-sol', baseUrl: 'https://chatgpt.com/backend-api/' }).capabilities.contextWindowTokens).toBe(known.capabilities.contextWindowTokens);
});
