/**
 * Fluent AI pipeline runtime.
 *
 * Composable step-based pipeline with retry, validation (zod),
 * transforms, and LLM integration. No external deps except zod.
 */

import type { IAIPipeline, IAIPromptBuilder, IAIPromptService, PipelineOptions } from '../contracts/IAIBuilder.js';
import { z } from 'zod';

interface PipelineStep {
    name: string;
    fn: (input: any) => Promise<any> | any;
    options: PipelineOptions;
}

export class AIPipeline<T> implements IAIPipeline<T> {
    private steps: PipelineStep[] = [];
    private catchHandler?: (error: Error) => Promise<any> | any;

    constructor(
        private promptService: IAIPromptService,
        private startValue?: T
    ) {}

    private addStep(name: string, fn: (input: any) => any) {
        this.steps.push({
            name,
            fn,
            options: { retry: 0 },
        });
    }

    private getLastStep(): PipelineStep {
        if (this.steps.length === 0) {
            throw new Error('Pipeline is empty. Cannot configure previous step.');
        }
        return this.steps[this.steps.length - 1];
    }

    pipe<Next>(fn: (input: T) => Promise<Next> | Next): IAIPipeline<Next> {
        this.addStep('pipe', fn);
        return this as unknown as IAIPipeline<Next>;
    }

    transform<Next>(fn: (input: T) => Promise<Next> | Next): IAIPipeline<Next> {
        const step = this.getLastStep();
        const previousFn = step.fn;
        step.fn = async (input: any) => {
            const result = await previousFn(input);
            return await fn(result);
        };
        return this as unknown as IAIPipeline<Next>;
    }

    retry(count: number): IAIPipeline<T> {
        const step = this.getLastStep();
        step.options.retry = count;
        return this;
    }

    validate<S>(schema: z.ZodType<S>): IAIPipeline<S> {
        const step = this.getLastStep();
        const previousFn = step.fn;
        step.fn = async (input: any) => {
            const result = await previousFn(input);
            const parsed = await schema.safeParseAsync(result);
            if (!parsed.success) {
                throw new Error(`Validation Error: ${parsed.error.message}`);
            }
            return parsed.data;
        };
        return this as unknown as IAIPipeline<S>;
    }

    clog(logger: { info: (msg: string, ...args: any[]) => void }, message: string = 'Pipeline Step'): IAIPipeline<T> {
        const step = this.getLastStep();
        const previousFn = step.fn;
        step.fn = async (input: any) => {
            const result = await previousFn(input);
            logger.info(message, { value: result });
            return result;
        };
        return this;
    }

    llm<Out = string>(configure: (builder: IAIPromptBuilder) => void, model?: string, options?: PipelineOptions): IAIPipeline<Out> {
        this.addStep('llm', async (input: any) => {
            const builder = this.promptService.use(model);

            if (typeof input === 'string') {
                builder.user(input);
            } else if (input !== undefined && input !== null) {
                builder.user(JSON.stringify(input));
            }

            configure(builder);

            return await builder.run<Out>();
        });

        if (options) {
            const step = this.getLastStep();
            step.options = { ...step.options, ...options };
        }

        return this as unknown as IAIPipeline<Out>;
    }

    catch(handler: (error: Error) => Promise<T> | T): IAIPipeline<T> {
        this.catchHandler = handler;
        return this;
    }

    async run(initialValue?: T): Promise<T> {
        let current: any = initialValue !== undefined ? initialValue : this.startValue;

        try {
            for (const step of this.steps) {
                let attempts = 0;
                const maxRetries = step.options.retry || 0;

                while (true) {
                    try {
                        current = await step.fn(current);
                        break;
                    } catch (error) {
                        attempts++;
                        if (attempts > maxRetries) {
                            throw error;
                        }
                        await new Promise(r => setTimeout(r, 200 * attempts));
                    }
                }
            }
        } catch (error: any) {
            if (this.catchHandler) {
                return await this.catchHandler(error);
            }
            throw error;
        }

        return current as T;
    }
}
