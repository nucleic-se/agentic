import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultAgentExtensions } from './preset.js';
import { compositionFingerprint } from './composition.js';

const construct = vi.hoisted(() => vi.fn());
vi.mock('../../providers/subscription.js', () => ({ SubscriptionProvider: class {
    constructor(options: unknown) { construct(options); }
} }));

it('configures reasoning without replacing the provider and preserves the default composition identity', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'preset-provider-'));
    try {
        const defaults = await defaultAgentExtensions({ workspace });
        const low = await defaultAgentExtensions({ workspace, reasoningEffort: 'low' });
        const medium = await defaultAgentExtensions({ workspace, model: 'gpt-5.6-sol', reasoningEffort: 'medium' });
        expect(compositionFingerprint(defaults)).toBe(compositionFingerprint(low));
        expect(defaults.find(e => e.roles?.provider)?.configuration).toBeUndefined();
        const solLow = await defaultAgentExtensions({ workspace, model: 'gpt-5.6-sol' });
        expect(compositionFingerprint(solLow)).not.toBe(compositionFingerprint(medium));
        await medium.find(e => e.roles?.provider)!.roles!.provider!();
        expect(construct).toHaveBeenLastCalledWith({ model: 'gpt-5.6-sol', authFilePath: undefined, reasoningEffort: 'medium' });
        await defaults.find(e => e.roles?.provider)!.roles!.provider!();
        expect(construct).toHaveBeenLastCalledWith({ model: 'gpt-6-astra', authFilePath: undefined, reasoningEffort: 'low' });
    } finally { await rm(workspace, { recursive: true, force: true }); }
});
