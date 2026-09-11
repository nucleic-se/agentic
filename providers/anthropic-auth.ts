import { createModels, type AuthInteraction, type CredentialStore } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';

export type { AuthInteraction, CredentialStore } from '@earendil-works/pi-ai';

/** OAuth-only access to the application's Anthropic subscription credentials.
 * The application owns interaction and storage; nothing discovers or reads home directories. */
export function createAnthropicSubscriptionAuth(store: CredentialStore) {
    const provider = anthropicProvider();
    const models = createModels({
        credentials: store,
        authContext: { env: async () => undefined, fileExists: async () => false },
    });
    // Never silently select a paid API key or ambient authentication instead of OAuth.
    models.setProvider({ ...provider, auth: { oauth: provider.auth.oauth } });
    return {
        async login(interaction: AuthInteraction): Promise<void> {
            try {
                await models.login('anthropic', 'oauth', interaction);
            } catch {
                interaction.signal?.throwIfAborted();
                // OAuth transport failures can include token response bodies in their causes.
                throw new Error('Anthropic subscription login failed. Retry login and check credential storage permissions.');
            }
        },
        async credentials(signal?: AbortSignal): Promise<string> {
            signal?.throwIfAborted();
            let result;
            try {
                result = await models.getAuth('anthropic', { signal });
            } catch {
                signal?.throwIfAborted();
                throw new Error('Anthropic subscription authentication failed. Check credential storage and its lock, then retry or sign in again.');
            }
            signal?.throwIfAborted();
            if (result?.source !== 'OAuth' || !result.auth.apiKey) {
                throw new Error('Anthropic subscription login is required');
            }
            return result.auth.apiKey;
        },
    };
}
