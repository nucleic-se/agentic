/**
 * Fluent AI prompt builder runtime.
 *
 * Decoupled from any DI container — takes an ILLMProvider directly.
 */

import type { ILLMProvider } from '../contracts/ILLMProvider.js';
import type { IAIPromptBuilder, IAIPromptService, IAIPipeline } from '../contracts/IAIBuilder.js';
import { AIPipeline } from './AIPipeline.js';

export class AIPromptService implements IAIPromptService {
    constructor(private llmProvider: ILLMProvider) {}

    use(model?: string): IAIPromptBuilder {
        return new AIPromptBuilder(this.llmProvider, model);
    }

    pipeline<T>(start: T): IAIPipeline<T> {
        return new AIPipeline<T>(this, start);
    }
}

export class AIPromptBuilder implements IAIPromptBuilder {
    private systemMessage?: string;
    private userMessage?: string;
    private schemaValue?: any;

    constructor(private llmProvider: ILLMProvider, private model?: string) {}

    system(message: string): IAIPromptBuilder {
        this.systemMessage = this.systemMessage
            ? `${this.systemMessage}\n\n${message}`
            : message;
        return this;
    }

    user(message: string): IAIPromptBuilder {
        this.userMessage = this.userMessage
            ? `${this.userMessage}\n\n${message}`
            : message;
        return this;
    }

    schema(schema: any): IAIPromptBuilder {
        this.schemaValue = schema;
        return this;
    }

    async run<T = string>(): Promise<T> {
        const instructions = this.systemMessage ?? '';
        const text = this.userMessage ?? '';
        const schema = this.schemaValue ?? { response: 'string' };

        const result = await this.llmProvider.process<any>({
            instructions,
            text,
            schema,
            model: this.model,
        });

        // If using default schema, unwrap the response
        if (!this.schemaValue) {
            return result.response as T;
        }

        return result as T;
    }
}
