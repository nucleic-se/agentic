/** Immutable pipeline definitions; every transform is an explicit retry boundary. */
import type { IAIPipeline, IPipelineRun, IAIPromptBuilder, IAIPromptService, PipelineOptions } from '../contracts/IAIBuilder.js';
import type { z } from 'zod';
import type { ModelTier, ProviderCallOptions } from '../contracts/llm.js';
import { setTimeout as delay } from 'node:timers/promises';
import { executionSignal } from './ExecutionOptions.js';

type Step = { fn: (input: unknown, options?: ProviderCallOptions) => unknown | Promise<unknown>; retries: number };
const retryCount = (count: number): number => {
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Retry count must be a nonnegative safe integer');
    return count;
};
export class AIPipeline<T> implements IAIPipeline<T> {
    private constructor(
        private readonly promptService: IAIPromptService,
        private readonly startValue?: unknown,
        private readonly steps: readonly Step[] = [],
        private readonly catchHandler?: (error: Error) => unknown | Promise<unknown>,
    ) {}
    static start<T>(service: IAIPromptService, value: T): AIPipeline<T> { return new AIPipeline<T>(service, value); }
    private append<Next>(fn: (input: T, options?: ProviderCallOptions) => Next | Promise<Next>, retries = 0): AIPipeline<Next> {
        return new AIPipeline<Next>(this.promptService, this.startValue,
            [...this.steps, { fn: (input, options) => fn(input as T, options), retries }], this.catchHandler);
    }
    pipe<Next>(fn: (input: T, options?: ProviderCallOptions) => Next | Promise<Next>): IAIPipeline<Next> {
        return this.append(fn);
    }
    transform<Next>(fn: (input: T, options?: ProviderCallOptions) => Next | Promise<Next>): IAIPipeline<Next> {
        return this.append(fn);
    }
    retry(count: number): IAIPipeline<T> {
        retryCount(count);
        if (!this.steps.length) throw new Error('Pipeline is empty. Cannot configure previous step.');
        return new AIPipeline<T>(this.promptService, this.startValue,
            this.steps.map((step, index) => index === this.steps.length - 1 ? { ...step, retries: count } : step), this.catchHandler);
    }
    validate<S>(schema: z.ZodType<S>): IAIPipeline<S> {
        return this.append(async input => {
            const parsed = await schema.safeParseAsync(input);
            if (!parsed.success) throw new Error(`Validation Error: ${parsed.error.message}`);
            return parsed.data;
        });
    }
    clog(logger: { info: (msg: string, ...args: unknown[]) => void }, message = 'Pipeline Step'): IAIPipeline<T> {
        return this.append(input => { logger.info(message, { value: input }); return input; });
    }
    llm<Out>(configure: (builder: IAIPromptBuilder) => IAIPromptBuilder<Out>, tier?: ModelTier, options?: PipelineOptions): IAIPipeline<Out>;
    llm(configure: (builder: IAIPromptBuilder) => void, tier?: ModelTier, options?: PipelineOptions): IAIPipeline<string>;
    llm<Out>(configure: (builder: IAIPromptBuilder) => IAIPromptBuilder<Out> | void, tier?: ModelTier, options?: PipelineOptions): IAIPipeline<Out | string> {
        return this.append(async (input, executionOptions) => {
            const builder = this.promptService.use(tier);
            if (typeof input === 'string') builder.user(input);
            else if (input !== undefined && input !== null) builder.user(JSON.stringify(input));
            return (configure(builder) ?? builder).run(executionOptions);
        }, retryCount(options?.retry ?? 0));
    }
    catch(handler: (error: Error) => Promise<T> | T): IPipelineRun<T> {
        return new AIPipeline<T>(this.promptService, this.startValue, this.steps, handler);
    }
    async run(options?: ProviderCallOptions): Promise<T> {
        const execution = executionSignal(options ?? {});
        let current: unknown = this.startValue;
        try {
            execution.signal?.throwIfAborted();
            for (const step of this.steps) {
                const input = current;
                for (let attempt = 0; ; attempt++) {
                    execution.signal?.throwIfAborted();
                    try {
                        current = await step.fn(input, { ...options, signal: execution.signal });
                        execution.signal?.throwIfAborted();
                        break;
                    } catch (error) {
                        execution.signal?.throwIfAborted();
                        if (attempt >= step.retries) throw error;
                        await delay(200 * (attempt + 1), undefined, { signal: execution.signal });
                    }
                }
            }
            return current as T;
        } catch (error) {
            execution.signal?.throwIfAborted();
            if (this.catchHandler) {
                const recovered = await this.catchHandler(error instanceof Error ? error : new Error(String(error)));
                execution.signal?.throwIfAborted();
                return recovered as T;
            }
            throw error;
        } finally { execution.dispose(); }
    }
}
