import { createHash } from 'node:crypto';
import type { ILLMProvider } from '../contracts/llm.js';
import type { OpenAICompatibleConfig } from './openai-compatible.js';
import type { AnthropicConfig } from './anthropic.js';
import type { SubscriptionProviderOptions } from './subscription.js';
import type { AnthropicSubscriptionProviderOptions } from './anthropic-subscription.js';

/** API-key selections derive an identity from known options. Supply a non-secret
 * providerIdentity when using opaque gateway settings or callbacks. */
export type ProviderSelection =
    | ({ provider: 'openai'; auth: 'api-key'; providerIdentity?: string } & OpenAICompatibleConfig)
    | ({ provider: 'anthropic'; auth: 'api-key'; providerIdentity?: string } & AnthropicConfig)
    | ({ provider: 'openai'; auth: 'subscription' } & SubscriptionProviderOptions)
    | ({ provider: 'anthropic'; auth: 'subscription' } & AnthropicSubscriptionProviderOptions);

/** Opaque overrides need a caller-owned identity; credentials never enter the digest. */
function apiIdentity(config: Extract<ProviderSelection, { auth: 'api-key' }>, baseUrl: string): string {
    if (config.providerIdentity !== undefined) {
        if (typeof config.providerIdentity !== 'string' || !config.providerIdentity.trim()) throw new Error('providerIdentity must be nonempty');
        return config.providerIdentity;
    }
    if (config.provider === 'openai'
        ? Object.keys(config.headers ?? {}).length || Object.keys(config.extraBody ?? {}).length || config.retry?.onRetry
        : config.onRetry) {
        throw new Error('Opaque provider overrides require an explicit providerIdentity');
    }
    const behavior = config.provider === 'openai' ? {
        embeddingModel: config.embeddingModel ?? config.model,
        providerName: config.providerName ?? 'OpenAICompatibleProvider',
        recoverTextToolCalls: config.recoverTextToolCalls ?? false,
        previousResponseContinuation: config.previousResponseContinuation ?? false,
        retry: {
            retryableStatuses: [...config.retry?.retryableStatuses ?? [429, 502, 503, 529]].sort((a, b) => a - b),
            maxRetries: config.retry?.maxRetries ?? 6,
            baseDelayMs: config.retry?.baseDelayMs ?? 2000,
            maxDelayMs: config.retry?.maxDelayMs ?? 60000,
            resetHeaders: config.retry?.resetHeaders ?? [],
        },
    } : {
        maxTokens: config.maxTokens ?? 4096,
        minRequestSpacingMs: config.minRequestSpacingMs ?? 1000,
    };
    return 'agentic-api-v1:' + createHash('sha256').update(JSON.stringify({
        provider: config.provider, model: config.model, baseUrl, behavior,
    })).digest('hex');
}

/** Select a provider for Agentic's existing execution loop. Optional subscription
 * backends load only when selected; importing this module never acquires credentials.
 * API keys resolve from explicit options, then AGENTIC_*_API_KEY, then *_API_KEY.
 */
export async function selectProvider(config: ProviderSelection): Promise<ILLMProvider> {
    if (typeof config.model !== 'string' || !config.model.trim()) throw new Error('Provider selection requires a nonempty model');
    if (config.provider !== 'openai' && config.provider !== 'anthropic') throw new Error('Unsupported provider selection');
    if (config.auth === 'api-key') {
        const env = config.provider === 'openai' ? 'OPENAI' : 'ANTHROPIC';
        const apiKey = config.apiKey ?? process.env[`AGENTIC_${env}_API_KEY`] ?? process.env[`${env}_API_KEY`];
        if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error(`${config.provider} API-key authentication requires an API key`);
        if (config.provider === 'openai') {
            const baseUrl = config.baseUrl ?? process.env.AGENTIC_OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
            const identity = apiIdentity(config, baseUrl.replace(/\/$/, ''));
            const { OpenAICompatibleProvider } = await import('./openai-compatible.js');
            const provider = new OpenAICompatibleProvider({ ...config, apiKey, baseUrl });
            Object.defineProperty(provider, 'configurationIdentity', { value: identity, enumerable: true });
            return provider;
        }
        const identity = apiIdentity(config, config.baseUrl ?? 'https://api.anthropic.com');
        const { AnthropicProvider } = await import('./anthropic.js');
        const provider = new AnthropicProvider({ ...config, apiKey });
        Object.defineProperty(provider, 'configurationIdentity', { value: identity, enumerable: true });
        return provider;
    }
    if (config.auth === 'subscription') {
        if (config.provider === 'openai') {
            const { SubscriptionProvider } = await import('./subscription.js');
            return new SubscriptionProvider(config);
        }
        const { AnthropicSubscriptionProvider } = await import('./anthropic-subscription.js');
        return new AnthropicSubscriptionProvider(config);
    }
    throw new Error('Unsupported provider authentication');
}
