/**
 * Chain-of-Thought (CoT) Pattern
 *
 * Decomposes complex problems into intermediate reasoning steps before
 * arriving at a final answer.
 *
 * Flow: decompose → reason (per step) → synthesize
 *
 * @module patterns/chain-of-thought
 */

import type { GraphState, IGraphEngine } from '../contracts/index.js';
import type { PatternConfig } from './types.js';
import { StateGraphBuilder } from '../runtime/graph/StateGraphBuilder.js';
import { LlmGraphNode } from '../runtime/graph/nodes/LlmGraphNode.js';
import { CallbackGraphNode } from '../runtime/graph/nodes/CallbackGraphNode.js';
import { END } from '../contracts/graph/index.js';

/**
 * State for Chain-of-Thought pattern execution.
 */
export interface ChainOfThoughtState extends GraphState {
    /** The problem or question */
    problem: string;
    /** Decomposed reasoning steps */
    steps: string[];
    /** Current step index being processed */
    currentStep: number;
    /** Reasoning for each step */
    stepReasoning: string[];
    /** Final synthesized answer */
    answer: string;
}

/**
 * Configuration for Chain-of-Thought pattern.
 */
export interface ChainOfThoughtConfig extends PatternConfig<ChainOfThoughtState> {
    /** Maximum number of reasoning steps (default: 5) */
    maxSteps?: number;
}

/**
 * Creates a Chain-of-Thought agent.
 *
 * The agent first decomposes a problem into reasoning steps, then
 * processes each step sequentially, finally synthesizing the results
 * into a final answer.
 *
 * @example
 * ```ts
 * const agent = createChainOfThoughtAgent({
 *   llm: myLlm,
 *   maxSteps: 5,
 * });
 *
 * const result = await agent.run({
 *   problem: 'If Alice has 3 apples and Bob has twice as many, how many total?',
 *   steps: [], currentStep: 0, stepReasoning: [], answer: '',
 * });
 * console.log(result.state.answer);
 * ```
 */
export function createChainOfThoughtAgent(
    config: ChainOfThoughtConfig,
): IGraphEngine<ChainOfThoughtState> {
    const maxSteps = config.maxSteps ?? 5;

    // Decomposer: break problem into reasoning steps
    const decomposer = new LlmGraphNode<ChainOfThoughtState>({
        id: 'decompose',
        provider: config.llm,
        prompt: (state) => ({
            instructions: `Break down the problem into clear, logical reasoning steps.
Each step should build on the previous ones.

Respond with JSON:
{
  "steps": ["step 1", "step 2", ...]
}`,
            text: state.problem,
            schema: {
                type: 'object',
                properties: {
                    steps: {
                        type: 'array',
                        items: { type: 'string' },
                    },
                },
                required: ['steps'],
            },
        }),
        outputKey: 'steps',
        temperature: 0.7,
    });

    // Parse decomposition
    const parseSteps = new CallbackGraphNode<ChainOfThoughtState>(
        'parse_steps',
        async (state) => {
            try {
                const parsed = typeof state.steps === 'string'
                    ? JSON.parse(state.steps as unknown as string)
                    : state.steps;

                state.steps = parsed.steps || [];
            } catch {
                // If parsing fails, treat as single step
                state.steps = [String(state.steps)];
            }

            // Limit to maxSteps
            if (state.steps.length > maxSteps) {
                state.steps = state.steps.slice(0, maxSteps);
            }

            state.stepReasoning = [];
        },
    );

    // Reasoner: process one step at a time
    const reasoner = new LlmGraphNode<ChainOfThoughtState>({
        id: 'reason_step',
        provider: config.llm,
        prompt: (state) => {
            const currentStepText = state.steps[state.currentStep];
            const previousReasoning = state.stepReasoning.length > 0
                ? `\n\nPrevious reasoning:\n${state.stepReasoning.join('\n')}`
                : '';

            return {
                instructions: `Work through this reasoning step carefully.${previousReasoning}`,
                text: `Step ${state.currentStep + 1}: ${currentStepText}`,
            };
        },
        outputKey: 'answer', // Temporary storage
        temperature: 0.5,
    });

    // Save step reasoning
    const saveReasoning = new CallbackGraphNode<ChainOfThoughtState>(
        'save_reasoning',
        async (state) => {
            state.stepReasoning.push(state.answer);
            state.currentStep++;
        },
    );

    // Synthesizer: combine all reasoning into final answer
    const synthesizer = new LlmGraphNode<ChainOfThoughtState>({
        id: 'synthesize',
        provider: config.llm,
        prompt: (state) => ({
            instructions: `Based on the step-by-step reasoning, provide a clear final answer to the original problem.

Original problem: ${state.problem}

Reasoning steps:
${state.stepReasoning.map((r, i) => `${i + 1}. ${r}`).join('\n')}

Provide a concise final answer.`,
            text: '',
        }),
        outputKey: 'answer',
        temperature: 0.3,
    });

    return new StateGraphBuilder<ChainOfThoughtState>()
        .addNode(decomposer)
        .addNode(parseSteps)
        .addNode(reasoner)
        .addNode(saveReasoning)
        .addNode(synthesizer)
        .setEntry('decompose')
        .addEdge('decompose', 'parse_steps')
        .addConditionalEdge('parse_steps', (state) =>
            state.steps.length === 0 ? 'synthesize' : 'reason_step',
        )
        .addEdge('reason_step', 'save_reasoning')
        .addConditionalEdge('save_reasoning', (state) => {
            // Continue to next step or synthesize
            if (state.currentStep >= state.steps.length) {
                return 'synthesize';
            }
            return 'reason_step';
        })
        .build({
            maxSteps: maxSteps * 3 + 5,
            tracer: config.tracer,
        });
}
