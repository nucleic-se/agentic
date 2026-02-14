/**
 * LLM provider contract.
 *
 * Domain-agnostic abstraction over language model APIs.
 * Supports structured output (JSON Schema) and embeddings.
 */

export interface LLMRequest<T = any> {
    instructions: string;
    text: string;
    schema: any; // JSON Schema definition
    model?: string;
    temperature?: number;
}

export interface ILLMProvider {
    process<T = any>(request: LLMRequest<T>): Promise<T>;
    embed(text: string): Promise<number[]>;
}
