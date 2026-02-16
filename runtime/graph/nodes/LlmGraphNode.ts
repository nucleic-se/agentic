/**
 * LLM graph node — calls an LLM provider and writes the result to state.
 *
 * Decoupled from prompt construction — the caller supplies a `prompt`
 * function that reads whatever it needs from state. The LLM output is
 * written to the designated `outputKey` field.
 *
 * ```ts
 * const research = new LlmGraphNode<MyState>({
 *     id: 'research',
 *     provider: myLlm,
 *     prompt: (s) => ({
 *         instructions: 'Research the topic.',
 *         text: s.topic as string,
 *     }),
 *     outputKey: 'sources',
 * });
 * ```
 *
 * @module runtime/graph/nodes
 */

import type { IGraphNode, GraphContext, GraphState } from '../../../contracts/graph/index.js';
import type { ILLMProvider } from '../../../contracts/ILLMProvider.js';

/** Configuration for an LLM graph node. */
export interface LlmGraphNodeConfig<TState extends GraphState> {
    /** Unique node ID. Must be non-empty. */
    id: string;
    /** LLM provider (structurally compatible with ILLMProvider). */
    provider: ILLMProvider;
    /** Build the prompt from current state. Returns { instructions, text }. */
    prompt: (state: Readonly<TState>) => { instructions: string; text: string };
    /** State key to write the LLM output to. */
    outputKey: keyof TState & string;
    /** Optional JSON Schema for structured output. */
    schema?: Record<string, unknown>;
    /** Optional model override. */
    model?: string;
    /** Optional temperature override (0–2). */
    temperature?: number;
}

export class LlmGraphNode<TState extends GraphState = GraphState>
    implements IGraphNode<TState>
{
    public readonly id: string;
    private readonly config: Readonly<LlmGraphNodeConfig<TState>>;

    constructor(config: LlmGraphNodeConfig<TState>) {
        if (!config.id || config.id.trim().length === 0) {
            throw new Error('LlmGraphNode: id must be a non-empty string.');
        }
        if (!config.provider || typeof config.provider.process !== 'function') {
            throw new Error('LlmGraphNode: provider with a process() method is required.');
        }
        if (typeof config.prompt !== 'function') {
            throw new Error('LlmGraphNode: prompt must be a function.');
        }
        if (!config.outputKey || config.outputKey.trim().length === 0) {
            throw new Error('LlmGraphNode: outputKey must be a non-empty string.');
        }
        this.id = config.id;
        this.config = config;
    }

    async process(state: TState, _context: GraphContext<TState>): Promise<void> {
        const { instructions, text } = this.config.prompt(state);

        const result = await this.config.provider.process({
            instructions,
            text,
            schema: this.config.schema,
            model: this.config.model,
            temperature: this.config.temperature,
        });

        (state as Record<string, unknown>)[this.config.outputKey] = result;
    }
}
