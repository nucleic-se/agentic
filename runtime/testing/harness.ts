import assert from 'node:assert/strict';
import type { ILLMProvider, Message, TurnRequest } from '../../contracts/llm.js';
import type { ContextStrategy } from '../harness/types.js';
import { budgetedContext } from '../harness/defaults.js';

export interface HarnessBoundaryFixture {
    /** Drive to a committed terminal state, including failures, and return durable history. */
    run(input: string): Promise<readonly Message[]>;
    close(): Promise<void>;
}
export type HarnessBoundaryFactory = (roles: { provider: ILLMProvider; context: ContextStrategy }) => Promise<HarnessBoundaryFixture>;

/** The same behavioral checks run against interactive and queued compositions. */
export async function assertHarnessBoundaryConformance(factory: HarnessBoundaryFactory): Promise<{ passed: true; checks: string[] }> {
    const checks: string[] = [];
    for (const mode of ['selection', 'rejected', 'invalid'] as const) {
        const requests: TurnRequest[] = [];
        let selections = 0, manifest: unknown;
        const provider: ILLMProvider = {
            async turn(request) {
                requests.push(structuredClone(request));
                return { message: { role: 'assistant', content: 'complete' }, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } };
            },
            async structured() { throw new Error('Unexpected structured request'); },
        };
        const context: ContextStrategy = { async assemble(messages, signal, options) {
            selections++;
            if (mode === 'rejected') throw new Error('Selection failed');
            if (mode === 'invalid') return { messages: null } as never;
            manifest = structuredClone(options?.tools ?? []);
            // An extension's scratch mutations must not change durable history or the tool grant.
            messages[0].content = 'corrupted-source';
            options?.tools?.push({ name: 'ungranted', description: 'must not reach the provider', parameters: { type: 'object' } });
            return budgetedContext('selected-system', 16000).assemble([{ role: 'user', content: 'selected-evidence' }], signal,
                { ...options, system: 'selected-system', tools: structuredClone(manifest) as TurnRequest['tools'] });
        } };
        const fixture = await factory({ provider, context });
        try {
            const history = await fixture.run('original-objective');
            assert.equal(selections, 1, 'Prepare context exactly once per request');
            assert.equal(history[0]?.content, 'original-objective', 'Persist original input, not the selected projection');
            if (mode === 'selection') {
                assert.equal(requests.length, 1);
                assert.equal(requests[0].system, 'selected-system');
                assert.deepEqual(requests[0].messages, [{ role: 'user', content: 'selected-evidence' }]);
                assert.deepEqual(requests[0].tools ?? [], manifest, 'Context selection cannot change tool capabilities');
            } else assert.equal(requests.length, 0, 'Rejected/invalid context must prevent provider dispatch');
            checks.push(mode);
        } finally { await fixture.close(); }
    }
    return { passed: true, checks };
}
