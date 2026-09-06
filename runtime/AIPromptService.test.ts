import { describe, expect, it, vi } from 'vitest';
import type { ILLMProvider, TurnResponse } from '../contracts/llm.js';
import { AIPromptService } from './AIPromptService.js';

const answer = (content: string): TurnResponse => ({ message: { role: 'assistant', content }, stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 1 } });
function provider(turn: ILLMProvider['turn']): ILLMProvider {
    return { turn, structured: async () => { throw new Error('unused'); }, embed: async () => [] };
}

describe('fluent composition through shared model execution', () => {
    it('exposes stability boundaries while sending ordinary portable requests', async () => {
        const turn = vi.fn<ILLMProvider['turn']>(async () => answer('ok'));
        const builder = new AIPromptService(provider(turn)).use()
            .context('remaining: 4', { id: 'state', stability: 'transient', priority: 100 })
            .contextGroup('instructions', ['Be accurate.', 'Cite evidence.'], { stability: 'stable', protected: true })
            .context('a fact', { id: 'evidence' }).user('Proceed');
        const prepared = await builder.prepare();
        expect(prepared.report.systemSections?.map(range => ({ id: range.id, text: prepared.request.system!.slice(range.start, range.end) }))).toEqual([
            { id: 'instructions', text: 'Be accurate.\n\nCite evidence.' }, { id: 'evidence', text: 'a fact' }, { id: 'state', text: 'remaining: 4' },
        ]);
        expect(await builder.run()).toBe('ok');
        expect(turn.mock.calls[0][0]).toEqual(prepared.request);
        expect(Object.keys(prepared.request).sort()).toEqual(['messages', 'system']);
        const structured = await builder.schema({ type: 'object' }).prepare();
        expect(structured.report.systemSections).toEqual(prepared.report.systemSections);
    });
    it('routes tier requests instead of silently using the default model', async () => {
        const fallback = provider(vi.fn(async () => answer('default')));
        const selected = provider(vi.fn(async () => answer('selected')));
        const select = vi.fn(() => selected);
        const service = new AIPromptService(fallback, { select });
        expect(await service.pipeline('question').llm(builder => builder.system('answer'), 'capable').run()).toBe('selected');
        expect(select).toHaveBeenCalledWith('capable');
        expect(fallback.turn).not.toHaveBeenCalled();
        expect(() => new AIPromptService(fallback).use('fast')).toThrow(/IModelRouter/);
    });

    it('does not pass truncated model output to downstream transforms', async () => {
        const transform = vi.fn((value: string) => JSON.parse(value));
        const service = new AIPromptService(provider(async () => ({ ...answer('{'), stopReason: 'max_tokens' })));
        await expect(service.pipeline('json').llm(() => {}).pipe(transform).run()).rejects.toThrow();
        expect(transform).not.toHaveBeenCalled();
    });

    it('cancels the active transport without retrying or swallowing cancellation', async () => {
        const controller = new AbortController(), reason = new Error('cancel requested');
        const turn = vi.fn(async (_request, options) => { controller.abort(reason); options?.signal?.throwIfAborted(); return answer('unreachable'); });
        const recover = vi.fn(() => 'recovered');
        const service = new AIPromptService(provider(turn));
        await expect(service.pipeline('question').llm(() => {}).retry(3).catch(recover).run({ signal: controller.signal })).rejects.toBe(reason);
        expect(turn).toHaveBeenCalledTimes(1);
        expect(recover).not.toHaveBeenCalled();
    });

    it('rejects retry configurations that would never reach a finite bound', () => {
        const service = new AIPromptService(provider(async () => answer('ok')));
        for (const count of [-1, NaN, Infinity, 0.5]) {
            expect(() => service.pipeline('').pipe(value => value).retry(count)).toThrow(RangeError);
            expect(() => service.pipeline('').llm(() => {}, undefined, { retry: count })).toThrow(RangeError);
        }
    });
});

describe('budgeted prompt preparation', () => {
    const counter = {
        countTokens: (text: string) => text.length,
        countTokensForMessages: (messages: { content: unknown }[]) => messages.reduce((sum, message) => sum + String(message.content).length, 0),
    };
    it('retains priority context and atomic groups, protects the question, and dispatches exactly the prepared request', async () => {
        const turn = vi.fn(async () => answer('ok'));
        const builder = new AIPromptService(provider(turn)).use()
            .system('S').user('Q')
            .context('low', { id: 'low', priority: 1 })
            .contextGroup('facts', ['A', 'B'], { priority: 10 })
            .budget({ total: 10, output: 2 }, counter);
        const prepared = await builder.prepare();
        expect(prepared.request.system).toBe('S\n\nA\n\nB');
        expect(prepared.request.maxTokens).toBe(2);
        expect(prepared.report.usage.totalTokens).toBe(10);
        expect(prepared.report.decisions.find(item => item.id === 'low')?.action).toBe('dropped');
        expect(prepared.report.decisions.find(item => item.id === 'facts')?.action).toBe('kept');
        expect(turn).not.toHaveBeenCalled();
        await builder.run();
        expect(turn.mock.calls[0][0]).toEqual(prepared.request);
    });
    it('snapshots request configuration while preparation is pending', async () => {
        const builder = new AIPromptService(provider(async () => answer('ok'))).use()
            .system('S').user('Q').budget({ total: 10, output: 2 }, counter);
        const pending = builder.prepare();
        builder.budget({ total: 100, output: 40 }, counter).user('later').context('later context');
        const prepared = await pending;
        expect(prepared.request.maxTokens).toBe(2);
        expect(prepared.report.usage.reservedOutputTokens).toBe(2);
        expect(prepared.request.messages[0].content).toBe('Q');
        expect(prepared.request.system).toBe('S');
        const subsequent = await builder.prepare();
        expect(subsequent.request.maxTokens).toBe(40);
        expect(subsequent.report.usage.reservedOutputTokens).toBe(40);
    });
    it('drops a whole group when it cannot fit, and fails before dispatch when protected content cannot fit', async () => {
        const turn = vi.fn(async () => answer('ok'));
        const service = new AIPromptService(provider(turn));
        const prepared = await service.use().user('Q').contextGroup('pair', ['AA', 'BB']).budget({ total: 3, output: 1 }, counter).prepare();
        expect(prepared.request.system).toBe('');
        expect(prepared.report.decisions.find(item => item.id === 'pair')?.action).toBe('dropped');
        await expect(service.use().system('required').user('Q').budget({ total: 2, output: 1 }, counter).run()).rejects.toThrow(/budget/);
        expect(turn).not.toHaveBeenCalled();
    });
    it('counts structured schema overhead and validates structured values before returning', async () => {
        const fake = provider(async () => answer('text'));
        fake.structured = vi.fn(async () => ({ value: { count: 'bad' }, usage: { inputTokens: 1, outputTokens: 1 } })) as ILLMProvider['structured'];
        const textBuilder = new AIPromptService(fake).use().user('Q');
        const structured = textBuilder.schema({ type: 'object' }, value => {
            if (typeof (value as {count?: unknown}).count !== 'number') throw new Error('count must be a number');
            return (value as {count: number}).count;
        }).budget({ total: 200, output: 10 }, counter);
        expect((await structured.prepare()).report.usage.schemaTokens).toBeGreaterThan(0);
        await expect(structured.run()).rejects.toThrow(/failed validation/);
        expect(await textBuilder.run()).toBe('text');
    });
});

describe('immutable explicit pipeline steps', () => {
    it('branches without changing the source type or value', async () => {
        const service = new AIPromptService(provider(async () => answer('ok')));
        const base = service.pipeline(2);
        const text = base.pipe(value => String(value));
        expect(await base.run()).toBe(2);
        expect(await text.run()).toBe('2');
    });
    it('does not replay a successful effect when a later transform fails', async () => {
        let effects = 0, parses = 0;
        const pipeline = new AIPromptService(provider(async () => answer('ok'))).pipeline(0)
            .pipe(() => ++effects).retry(2)
            .transform(() => { parses++; throw new Error('parse failed'); }).retry(1);
        await expect(pipeline.run()).rejects.toThrow('parse failed');
        expect(effects).toBe(1);
        expect(parses).toBe(2);
    });
    it('normalizes deadline into a cancellable signal for arbitrary steps and does not retry or recover expiry', async () => {
        const step = vi.fn(async (_input, options) => {
            await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }));
            options.signal.throwIfAborted();
        });
        const recover = vi.fn(() => undefined);
        const pipeline = new AIPromptService(provider(async () => answer('ok'))).pipeline(0).pipe(step).retry(3).catch(recover);
        await expect(pipeline.run({ deadline: Date.now() + 25 })).rejects.toThrow();
        expect(step).toHaveBeenCalledTimes(1);
        expect(recover).not.toHaveBeenCalled();
    });
});
