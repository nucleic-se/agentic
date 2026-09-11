/** CLI choices are explicit so a missing subscription never falls back to API billing. */
export function providerOptions(args: string[], env: NodeJS.ProcessEnv = process.env): {
    provider: 'openai' | 'anthropic';
    auth: 'api-key' | 'subscription';
    model: string | undefined;
    tokenBudget: number | undefined;
    login: boolean;
    authFilePath: string | undefined;
} {
    const value = (name: string): string | undefined => {
        const index = args.indexOf(name);
        if (index === -1) return undefined;
        const result = args[index + 1];
        if (!result || result.startsWith('--')) throw new Error(`Missing value for ${name}`);
        return result;
    };
    const provider = value('--provider') ?? 'openai';
    const auth = value('--auth') ?? 'subscription';
    if (provider !== 'openai' && provider !== 'anthropic') throw new Error('provider must be openai or anthropic');
    if (auth !== 'api-key' && auth !== 'subscription') throw new Error('auth must be api-key or subscription');
    const model = value('--model') ?? env.AGENTIC_MODEL ?? (auth === 'subscription' ? (provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-6-astra') : undefined);
    const login = args.includes('--login');
    if (!model && !login) throw new Error('Choose --model for this provider and authentication mode');
    if (login && auth !== 'subscription') throw new Error('--login is for subscription authentication; API keys come from the environment');
    const authFilePath = value('--auth-file');
    if (auth === 'api-key' && authFilePath !== undefined) throw new Error('--auth-file is for subscription authentication; API keys come from the environment');
    const requestedBudget = value('--context-tokens');
    const tokenBudget = requestedBudget === undefined ? undefined : Number(requestedBudget);
    if (tokenBudget !== undefined && (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1)) {
        throw new Error('context-tokens must be a positive safe integer');
    }
    if (auth === 'api-key' && tokenBudget === undefined) {
        throw new Error('Choose --context-tokens within your API model capacity');
    }
    return { provider, auth, model, tokenBudget, login, authFilePath };
}
