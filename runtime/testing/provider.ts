import assert from 'node:assert/strict';
import type { ILLMProvider, TokenUsage } from '../../contracts/llm.js';

export interface ConformanceReport { checks: string[] }
/** Deterministic transports: turn returns "ok"; structured/truncated return {answer:"ok"}. */
export type ProviderScenario = 'turn' | 'structured' | 'truncated' | 'blocked';
export interface ProviderScenarioFixture {
    provider: ILLMProvider;
    /** Normalize only transport observations, never the provider response being tested. */
    calls: Array<{ maxTokens?: number; signal?: AbortSignal | null }>;
    /** Resolves once blocked transport is entered. Blocked transport rejects when its signal aborts. */
    started: Promise<void>;
    dispose?(): void | Promise<void>;
}
export type ProviderScenarioFactory = (scenario: ProviderScenario) => ProviderScenarioFixture | Promise<ProviderScenarioFixture>;

async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([operation, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Provider conformance check timed out')), timeoutMs);
        })]);
    } finally { clearTimeout(timer); }
}
function validUsage(usage: TokenUsage): void {
    assert.ok(usage, 'Provider must preserve usage');
    assert.ok(Number.isFinite(usage.inputTokens) && usage.inputTokens >= 0, 'Invalid input usage');
    assert.ok(Number.isFinite(usage.outputTokens) && usage.outputTokens >= 0, 'Invalid output usage');
}
/**
 * Run serially against isolated, disposable adapters with injected fake transports.
 * Throws AssertionError (or a bounded timeout) on failure. No global test framework is needed.
 */
export async function assertProviderConformance(create: ProviderScenarioFactory, timeoutMs = 2000): Promise<ConformanceReport> {
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'timeoutMs must be a positive integer');
    const checks: string[] = [];
    const scenario = async (name: string, kind: ProviderScenario, check: (fixture: ProviderScenarioFixture) => Promise<void>) => {
        const fixture = await create(kind);
        try { await bounded(check(fixture), timeoutMs); checks.push(name); }
        finally { await fixture.dispose?.(); }
    };
    const messages = [{ role: 'user' as const, content: 'answer' }];
    await scenario('turn response and output limit', 'turn', async ({ provider, calls }) => {
        const response = await provider.turn({ messages, maxTokens: 37 });
        assert.equal(response.message.role, 'assistant');
        assert.equal(response.message.content, 'ok');
        assert.equal(response.stopReason, 'end_turn');
        validUsage(response.usage);
        assert.ok(calls.length > 0, 'Fixture must observe the real transport');
        assert.equal(calls[0].maxTokens, 37, 'Turn output limit must reach transport');
    });
    await scenario('structured response and output limit', 'structured', async ({ provider, calls }) => {
        const response = await provider.structured({ messages, schema: { type: 'object' }, maxTokens: 37 });
        assert.deepEqual(response.value, { answer: 'ok' });
        validUsage(response.usage);
        assert.ok(calls.length > 0, 'Fixture must observe the real transport');
        assert.equal(calls[0].maxTokens, 37, 'Structured output limit must reach transport');
    });
    await scenario('parseable truncated structured output is rejected with usage', 'truncated', async ({ provider }) => {
        await assert.rejects(provider.structured({ messages, schema: { type: 'object' }, maxTokens: 37 }), error => {
            assert.ok(error instanceof Error);
            assert.equal(error.name, 'LLMProtocolError');
            validUsage((error as Error & { usage: TokenUsage }).usage);
            return true;
        });
    });
    for (const method of ['turn', 'structured'] as const) {
        await scenario(`${method} pre-abort`, 'blocked', async ({ provider, calls }) => {
            const controller = new AbortController(); controller.abort(new Error('cancelled before dispatch'));
            await assert.rejects(provider[method]({ messages, schema: { type: 'object' } }, { signal: controller.signal }));
            assert.ok(calls.every(call => call.signal?.aborted), 'Any attempted transport must receive the aborted signal');
        });
        await scenario(`${method} active cancellation`, 'blocked', async ({ provider, calls, started }) => {
            const controller = new AbortController();
            const pending = provider[method]({ messages, schema: { type: 'object' } }, { signal: controller.signal });
            // Observe rejection immediately, including a broken adapter that rejects before transport starts.
            const settled = pending.then(() => ({ rejected: false }), () => ({ rejected: true }));
            try {
                await bounded(started, timeoutMs);
                controller.abort(new Error('cancelled in flight'));
                assert.equal((await settled).rejected, true, 'Cancellation must reject the provider call');
                assert.ok(calls.length > 0 && calls.every(call => call.signal?.aborted), 'Cancellation must reach transport');
            } finally { controller.abort(); }
        });
    }
    return { checks };
}
