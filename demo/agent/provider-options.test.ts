import { expect, it } from 'vitest';
import { providerOptions } from './provider-options.js';

it('defaults to OpenAI subscription with Astra and requires explicit API model and budget', () => {
    expect(providerOptions([], {})).toMatchObject({ provider: 'openai', auth: 'subscription', model: 'gpt-6-astra' });
    expect(providerOptions([], { AGENTIC_MODEL: 'chosen' }).model).toBe('chosen');
    expect(providerOptions(['--provider', 'openai'], {}).model).toBe('gpt-6-astra');
    expect(() => providerOptions(['--auth', 'api-key', '--model', 'chosen'], {})).toThrow('context-tokens');
    expect(providerOptions(['--provider', 'anthropic', '--auth', 'api-key', '--model', 'chosen', '--context-tokens', '32000'], {}))
        .toMatchObject({ provider: 'anthropic', auth: 'api-key', model: 'chosen', tokenBudget: 32000 });
});

it('validates choices without silently falling back or requiring a model during login', () => {
    expect(providerOptions(['--provider', 'anthropic', '--login'], {})).toMatchObject({ login: true, model: 'claude-sonnet-4-6' });
    expect(() => providerOptions(['--provider', 'typo'], {})).toThrow('provider must');
    expect(() => providerOptions(['--auth', 'typo'], {})).toThrow('auth must');
    expect(() => providerOptions(['--auth', 'api-key', '--login'], {})).toThrow('API keys');
    expect(() => providerOptions(['--auth', 'api-key', '--model', 'chosen', '--auth-file', '/unused'], {})).toThrow('--auth-file is for subscription');
    expect(() => providerOptions(['--context-tokens', 'NaN'], {})).toThrow('positive safe integer');
    expect(() => providerOptions(['--model'], {})).toThrow('Missing value');
});
