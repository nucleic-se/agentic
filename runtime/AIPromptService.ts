/**
 * Fluent AI prompt builder runtime.
 *
 * Decoupled from any DI container — takes an ILLMProvider directly.
 */

import type { ILLMProvider } from '../contracts/llm.js';
import type { IAIPromptBuilder, IAIPromptService, IAIPipeline } from '../contracts/IAIBuilder.js';
import { AIPipeline } from './AIPipeline.js';

export class AIPromptService implements IAIPromptService {
    constructor(private llmProvider: ILLMProvider) {}

    use(_model?: string): IAIPromptBuilder {
        return new AIPromptBuilder(this.llmProvider);
    }

    pipeline<T>(start: T): IAIPipeline<T> {
        return new AIPipeline<T>(this, start);
    }
}

export class AIPromptBuilder implements IAIPromptBuilder {
    private systemMessage?: string;
    private userMessage?:   string;
    private schemaValue?:   Record<string, unknown>;

    constructor(private llmProvider: ILLMProvider) {}

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

    schema(schema: Record<string, unknown>): IAIPromptBuilder {
        this.schemaValue = schema;
        return this;
    }

    async run<T = string>(): Promise<T> {
        const system  = this.systemMessage;
        const content = this.userMessage ?? '';

        if (this.schemaValue) {
            const result = await this.llmProvider.structured<T>({
                system,
                messages: [{ role: 'user', content }],
                schema:   { type: 'object', ...this.schemaValue },
            });
            return result.value;
        }

        // No schema — return plain text from a single turn.
        const result = await this.llmProvider.turn({
            system,
            messages: [{ role: 'user', content }],
        });
        return result.message.content as unknown as T;
    }
}
