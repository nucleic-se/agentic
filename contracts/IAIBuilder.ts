/**
 * Fluent AI builder and pipeline contracts.
 *
 * Domain-agnostic interfaces for composing LLM prompts and
 * chaining processing steps with retry, validation, and transforms.
 */

import { z } from 'zod';

export interface IAIPromptBuilder {
    system(message: string): IAIPromptBuilder;
    user(message: string): IAIPromptBuilder;
    schema(schema: any): IAIPromptBuilder;
    run<T = string>(): Promise<T>;
}

export interface IAIPromptService {
    use(model?: string): IAIPromptBuilder;
    pipeline<T>(start: T): IAIPipeline<T>;
}

export interface PipelineOptions {
    retry?: number;
}

export interface IAIPipeline<T> {
    pipe<Next>(fn: (input: T) => Promise<Next> | Next): IAIPipeline<Next>;

    /** Configure the previous step to retry on failure */
    retry(count: number): IAIPipeline<T>;

    /** Validate the previous step's output using Zod */
    validate<S>(schema: z.ZodType<S>): IAIPipeline<S>;

    /** Transform the data synchronously or asynchronously */
    transform<Next>(fn: (input: T) => Promise<Next> | Next): IAIPipeline<Next>;

    /** Log the current value for debugging */
    clog(logger: { info: (msg: string, ...args: any[]) => void }, message?: string): IAIPipeline<T>;

    llm<Out = string>(configure: (builder: IAIPromptBuilder) => void, model?: string, options?: PipelineOptions): IAIPipeline<Out>;

    catch(handler: (error: Error) => Promise<T> | T): IAIPipeline<T>;

    run(initialValue?: any): Promise<T>;
}
