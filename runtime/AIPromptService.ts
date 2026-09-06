/** Fluent frontend to shared context preparation and model execution. */
import type { ILLMProvider, IModelRouter, ModelTier, ProviderCallOptions, StructuredRequest } from '../contracts/llm.js';
import type { IAIPromptBuilder, IAIPromptService, IAIPipeline, PreparedPrompt, PromptBudget, PromptContextOptions } from '../contracts/IAIBuilder.js';
import type { PromptSection } from '../contracts/IPromptEngine.js';
import type { ITokenCounter } from '../contracts/ITokenCounter.js';
import { executeModelTurn, executeStructuredModel } from './ModelExecutor.js';
import { composeAgentContext } from './ContextPipeline.js';
import { executionSignal } from './ExecutionOptions.js';
import { AIPipeline } from './AIPipeline.js';

export class AIPromptService implements IAIPromptService {
    constructor(private readonly llmProvider: ILLMProvider, private readonly router?: IModelRouter) {}
    use(tier?: ModelTier): IAIPromptBuilder {
        if (tier !== undefined && !this.router) throw new Error('Model tier selection requires an IModelRouter');
        return AIPromptBuilder.create(tier === undefined ? this.llmProvider : this.router!.select(tier));
    }
    pipeline<T>(start: T): IAIPipeline<T> { return AIPipeline.start(this, start); }
}

export class AIPromptBuilder<T = string> implements IAIPromptBuilder<T> {
    private systemMessage = '';
    private userMessage = '';
    private sections: PromptSection[] = [];
    private schemaValue?: Record<string, unknown>;
    private parser?: (value: unknown) => T;
    private budgetValue?: PromptBudget;
    private tokenCounter?: ITokenCounter;
    private constructor(private readonly llmProvider: ILLMProvider) {}
    static create(provider: ILLMProvider): AIPromptBuilder<string> { return new AIPromptBuilder<string>(provider); }
    system(message: string): IAIPromptBuilder<T> {
        this.systemMessage = [this.systemMessage, message].filter(Boolean).join('\n\n');
        return this;
    }
    user(message: string): IAIPromptBuilder<T> {
        this.userMessage = [this.userMessage, message].filter(Boolean).join('\n\n');
        return this;
    }
    context(text: string, options: PromptContextOptions = {}): IAIPromptBuilder<T> {
        this.sections.push({ id: options.id ?? `context:${this.sections.length}`, priority: options.priority ?? 0,
            sticky: options.protected ?? false, stability: options.stability, text: () => text });
        return this;
    }
    contextGroup(id: string, members: readonly string[], options: Omit<PromptContextOptions, 'id'> = {}): IAIPromptBuilder<T> {
        if (!id.trim()) throw new Error('Context group id must be non-empty');
        return this.context(members.join('\n\n'), { ...options, id });
    }
    budget(budget: PromptBudget, tokenCounter?: ITokenCounter): IAIPromptBuilder<T> {
        if (!Number.isSafeInteger(budget.total) || budget.total < 1 || !Number.isSafeInteger(budget.output) || budget.output < 1) {
            throw new RangeError('Total budget and output reserve must be positive safe integers');
        }
        this.budgetValue = { ...budget };
        this.tokenCounter = tokenCounter;
        return this;
    }
    schema(schema: Record<string, unknown>): IAIPromptBuilder<unknown>;
    schema<Out>(schema: Record<string, unknown>, parse: (value: unknown) => Out): IAIPromptBuilder<Out>;
    schema<Out>(schema: Record<string, unknown>, parse?: (value: unknown) => Out): IAIPromptBuilder<Out | unknown> {
        // A new builder preserves the original builder's truthful string return type.
        const next = new AIPromptBuilder<Out | unknown>(this.llmProvider);
        next.systemMessage = this.systemMessage;
        next.userMessage = this.userMessage;
        next.sections = [...this.sections];
        next.budgetValue = this.budgetValue && { ...this.budgetValue };
        next.tokenCounter = this.tokenCounter;
        next.schemaValue = structuredClone(schema);
        next.parser = parse;
        return next;
    }
    private async prepareRequest(options?: ProviderCallOptions): Promise<PreparedPrompt> {
        // Snapshot before the first await: fluent changes configure subsequent calls only.
        const budget = this.budgetValue && { ...this.budgetValue };
        const schema = this.schemaValue && structuredClone(this.schemaValue);
        const system = this.systemMessage;
        const content = this.userMessage;
        const sections = [...this.sections];
        const tokenCounter = this.tokenCounter;
        const composed = await composeAgentContext({
            system,
            messages: [{ role: 'user', content, sticky: true }],
            sections,
            tokenBudget: budget?.total ?? Number.MAX_SAFE_INTEGER,
            reservedOutputTokens: budget?.output,
            responseSchema: schema,
            signal: options?.signal,
        }, { tokenCounter });
        const request = {
            system: composed.system,
            messages: composed.messages,
            ...(budget ? { maxTokens: budget.output } : {}),
            ...(schema ? { schema } : {}),
        };
        return { request, report: { usage: composed.usage, decisions: composed.decisions, systemSections: composed.systemSections } };
    }
    async prepare(options?: ProviderCallOptions): Promise<PreparedPrompt> {
        const execution = executionSignal(options ?? {});
        try { return await this.prepareRequest({ ...options, signal: execution.signal }); }
        finally { execution.dispose(); }
    }
    async run(options?: ProviderCallOptions): Promise<T> {
        const execution = executionSignal(options ?? {});
        try {
            const normalized = { ...options, signal: execution.signal };
            const parser = this.parser;
            const { request } = await this.prepareRequest(normalized);
            if ('schema' in request) {
                const result = await executeStructuredModel<T>(this.llmProvider, request as StructuredRequest,
                    { ...normalized, requireComplete: true, validateValue: parser });
                return result.value;
            }
            const result = await executeModelTurn(this.llmProvider, request,
                { ...normalized, requireComplete: true, allowToolCalls: false });
            // Only schema() creates a non-string builder, and that branch returns above.
            return result.message.content as T;
        } finally { execution.dispose(); }
    }
}
