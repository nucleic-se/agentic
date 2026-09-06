import { expectTypeOf, it } from 'vitest';
import type { ILLMProvider } from '../contracts/llm.js';
import { AIPromptService } from './AIPromptService.js';

// Compiled separately with tsc: public generic output is inferred from an executable parser.
function contracts(provider: ILLMProvider) {
    const service = new AIPromptService(provider);
    expectTypeOf(service.use().run()).toEqualTypeOf<Promise<string>>();
    expectTypeOf(service.use().schema({}).run()).toEqualTypeOf<Promise<unknown>>();
    expectTypeOf(service.use().schema({}, Number).run()).toEqualTypeOf<Promise<number>>();
    expectTypeOf(service.pipeline('q').llm(builder => builder.schema({}, Number)).run()).toEqualTypeOf<Promise<number>>();
    expectTypeOf(service.pipeline('q').llm(builder => builder.system('answer')).run()).toEqualTypeOf<Promise<string>>();
    // @ts-expect-error Runtime overrides cannot replace a pipeline's typed input.
    service.pipeline(1).run('wrong input');
    // @ts-expect-error A caller cannot claim arbitrary plain-text output types.
    service.use().run<{ invented: boolean }>();
    // @ts-expect-error A fallback is terminal so later operations cannot invalidate its output type.
    service.pipeline(1).catch(() => 1).pipe(String);
}
it('keeps compile-time contract checks inert at runtime', () => expectTypeOf(contracts).toBeFunction());
