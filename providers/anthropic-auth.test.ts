import { afterEach, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import { InMemoryCredentialStore, type OAuthCredential } from '@earendil-works/pi-ai';
import { createAnthropicSubscriptionAuth } from './anthropic-auth.js';

const oauth = vi.hoisted(() => ({ login: vi.fn(), refresh: vi.fn() }));
vi.mock('@earendil-works/pi-ai/providers/anthropic', async importOriginal => {
    const original = await importOriginal<typeof import('@earendil-works/pi-ai/providers/anthropic')>();
    return { anthropicProvider: () => ({ ...original.anthropicProvider(), auth: {
        oauth: { name: 'Test subscription', login: oauth.login, refresh: oauth.refresh,
            toAuth: async (credential: OAuthCredential) => ({ apiKey: credential.access }) },
    } }) };
});
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });
const fresh = (): OAuthCredential => ({ type: 'oauth', access: 'test-access', refresh: 'test-refresh', expires: Date.now() + 3600000 });

it('persists interactive OAuth through the caller store without exposing credentials as login output', async () => {
    const store = new InMemoryCredentialStore();
    const auth = createAnthropicSubscriptionAuth(store);
    const prompt = vi.fn(async () => 'test-code');
    const notify = vi.fn();
    const token = fresh();
    oauth.login.mockImplementation(async interaction => {
        interaction.notify({ type: 'auth_url', url: 'https://example.test/authorize' });
        expect(await interaction.prompt({ type: 'manual_code', message: 'Code' })).toBe('test-code');
        return token;
    });
    expect(await auth.login({ prompt, notify })).toBeUndefined();
    expect(notify).toHaveBeenCalledWith({ type: 'auth_url', url: 'https://example.test/authorize' });
    expect(await store.read('anthropic')).toEqual(token);
    expect(await auth.credentials()).toBe(token.access);
    expect(oauth.refresh).not.toHaveBeenCalled();
});

it('refreshes a rotated token once across concurrent requests under the store lock', async () => {
    const store = new InMemoryCredentialStore();
    await store.modify('anthropic', async () => ({ ...fresh(), expires: 0 }));
    const rotated = { ...fresh(), access: 'rotated-access', refresh: 'rotated-refresh' };
    oauth.refresh.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return rotated;
    });
    const auth = createAnthropicSubscriptionAuth(store);
    expect(await Promise.all([auth.credentials(), auth.credentials(), auth.credentials()])).toEqual(Array(3).fill(rotated.access));
    expect(oauth.refresh).toHaveBeenCalledOnce();
    expect(await store.read('anthropic')).toEqual(rotated);
});

it('keeps the stored credential when refresh fails and never falls back to ambient API keys', async () => {
    const store = new InMemoryCredentialStore();
    const old = { ...fresh(), expires: 0 };
    await store.modify('anthropic', async () => old);
    oauth.refresh.mockRejectedValue(new Error('Refresh unavailable'));
    const auth = createAnthropicSubscriptionAuth(store);
    await expect(auth.credentials()).rejects.toThrow('subscription authentication failed');
    expect(await store.read('anthropic')).toEqual(old);
    await store.delete('anthropic');
    vi.stubEnv('ANTHROPIC_API_KEY', 'ambient-test-key');
    await expect(auth.credentials()).rejects.toThrow('login is required');
    await store.modify('anthropic', async () => ({ type: 'api_key', key: 'stored-test-key' }));
    await expect(auth.credentials()).rejects.toThrow('login is required');
});

it('does not expose token-bearing OAuth errors or nested causes from login and refresh', async () => {
    const store = new InMemoryCredentialStore();
    const auth = createAnthropicSubscriptionAuth(store);
    const secret = 'fake-secret-token-never-log';
    const failure = new Error(`Invalid token response: ${secret}`, { cause: { refresh_token: secret } });
    oauth.login.mockRejectedValue(failure);
    oauth.refresh.mockRejectedValue(failure);
    const loginError = await auth.login({ prompt: vi.fn(), notify: vi.fn() }).catch(error => error);
    expect(loginError).toBeInstanceOf(Error);
    expect(loginError.message).toContain('subscription login failed');
    expect(inspect(loginError, { depth: 10 })).not.toContain(secret);
    expect(loginError.cause).toBeUndefined();
    await store.modify('anthropic', async () => ({ ...fresh(), expires: 0 }));
    const refreshError = await auth.credentials().catch(error => error);
    expect(refreshError).toBeInstanceOf(Error);
    expect(refreshError.message).toContain('subscription authentication failed');
    expect(inspect(refreshError, { depth: 10 })).not.toContain(secret);
    expect(refreshError.cause).toBeUndefined();
});

it('does not begin login or credential resolution after caller cancellation', async () => {
    const auth = createAnthropicSubscriptionAuth(new InMemoryCredentialStore());
    const signal = AbortSignal.abort(new Error('Cancelled by caller'));
    await expect(auth.credentials(signal)).rejects.toThrow('Cancelled by caller');
    await expect(auth.login({ signal, prompt: vi.fn(), notify: vi.fn() })).rejects.toThrow('Cancelled by caller');
    expect(oauth.login).not.toHaveBeenCalled();
    expect(oauth.refresh).not.toHaveBeenCalled();
});
