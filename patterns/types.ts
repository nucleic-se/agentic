/**
 * Shared types and interfaces for agentic design patterns.
 *
 * @module patterns
 */

import type { GraphState, ILLMProvider, ITracer, IGraphEngine } from '../index.js';

/**
 * Base configuration for all pattern factories.
 */
export interface PatternConfig<TState extends GraphState> {
    /** LLM provider for generating responses */
    llm: ILLMProvider;
    /** Optional tracer for observability */
    tracer?: ITracer;
    /** Maximum iterations before stopping (default: 10) */
    maxIterations?: number;
}

/**
 * Factory function that creates a graph engine for a specific pattern.
 */
export type PatternFactory<
    TState extends GraphState,
    TConfig extends PatternConfig<TState>,
> = (config: TConfig) => IGraphEngine<TState>;

/**
 * Tool function signature for ReAct and similar patterns.
 */
export type ToolFunction = (input: string) => Promise<string>;

/**
 * Collection of named tools.
 */
export type ToolRegistry = Record<string, ToolFunction>;

/**
 * Document retriever function for RAG and similar patterns.
 */
export type RetrieverFunction = (query: string) => Promise<string[]>;

/**
 * Human input function for human-in-the-loop patterns.
 */
export type HumanInputFunction = (prompt: string) => Promise<string>;
