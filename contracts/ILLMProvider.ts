/**
 * LLM provider contract.
 *
 * Domain-agnostic abstraction over language model APIs.
 * Supports structured output (JSON Schema) and embeddings.
 */

export interface LLMRequest<T = unknown> {
    instructions: string;
    text: string;
    /** JSON Schema definition for structured output. */
    schema?: Record<string, unknown>;
    model?: string;
    temperature?: number;
}

export interface ILLMProvider {
    process<T = any>(request: LLMRequest<T>): Promise<T>;
    embed(text: string): Promise<number[]>;
}
