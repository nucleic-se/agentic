/** Fluent frontends for the shared context and execution primitives. */
import type { z } from 'zod';
import type { ModelTier, ProviderCallOptions, StructuredRequest, TurnRequest } from './llm.js';
import type { ITokenCounter } from './ITokenCounter.js';
import type { ContextReport } from './IAgentContextAssembler.js';
import type { ContextStability } from './IPromptEngine.js';

export interface PromptContextOptions {
    id?: string;
    priority?: number;
    protected?: boolean;
    stability?: ContextStability;
}
export interface PromptBudget {
    total: number;
    output: number;
}
export interface PreparedPrompt {
    request: TurnRequest | StructuredRequest;
    report: ContextReport;
}
export interface IAIPromptBuilder<T = string> {
    system(message: string): IAIPromptBuilder<T>;
    user(message: string): IAIPromptBuilder<T>;
    context(text: string, options?: PromptContextOptions): IAIPromptBuilder<T>;
    /** All members survive or are dropped together. Nested selection is deliberately not supported. */
    contextGroup(id: string, members: readonly string[], options?: Omit<PromptContextOptions, 'id'>): IAIPromptBuilder<T>;
    budget(budget: PromptBudget, tokenCounter?: ITokenCounter): IAIPromptBuilder<T>;
    schema(schema: Record<string, unknown>): IAIPromptBuilder<unknown>;
    schema<Out>(schema: Record<string, unknown>, parse: (value: unknown) => Out): IAIPromptBuilder<Out>;
    /** Prepare and inspect the exact request without calling a provider. */
    prepare(options?: ProviderCallOptions): Promise<PreparedPrompt>;
    run(options?: ProviderCallOptions): Promise<T>;
}
export interface IAIPromptService {
    use(tier?: ModelTier): IAIPromptBuilder;
    pipeline<T>(start: T): IAIPipeline<T>;
}
export interface PipelineOptions {
    /** Additional attempts for this explicit step only. The caller owns replay safety. */
    retry?: number;
}
export interface IPipelineRun<T> {
    run(options?: ProviderCallOptions): Promise<T>;
}
export interface IAIPipeline<T> extends IPipelineRun<T> {
    pipe<Next>(fn: (input: T, options?: ProviderCallOptions) => Promise<Next> | Next): IAIPipeline<Next>;
    retry(count: number): IAIPipeline<T>;
    validate<S>(schema: z.ZodType<S>): IAIPipeline<S>;
    transform<Next>(fn: (input: T, options?: ProviderCallOptions) => Promise<Next> | Next): IAIPipeline<Next>;
    clog(logger: { info: (msg: string, ...args: unknown[]) => void }, message?: string): IAIPipeline<T>;
    llm<Out>(configure: (builder: IAIPromptBuilder) => IAIPromptBuilder<Out>, tier?: ModelTier, options?: PipelineOptions): IAIPipeline<Out>;
    llm(configure: (builder: IAIPromptBuilder) => void, tier?: ModelTier, options?: PipelineOptions): IAIPipeline<string>;
    catch(handler: (error: Error) => Promise<T> | T): IPipelineRun<T>;
    run(options?: ProviderCallOptions): Promise<T>;
}
