/**
 * Reflection / Self-Critique Pattern
 *
 * Generates an initial solution, critiques it, and iteratively refines
 * until quality threshold is met or max iterations reached.
 *
 * Flow: generate → critique → judge → (refine or finish)
 *
 * @module patterns/reflection
 */

import type { GraphState, IGraphEngine } from '../contracts/index.js';
import type { PatternConfig } from './types.js';
import { StateGraphBuilder } from '../runtime/graph/StateGraphBuilder.js';
import { LlmGraphNode } from '../runtime/graph/nodes/LlmGraphNode.js';
import { CallbackGraphNode } from '../runtime/graph/nodes/CallbackGraphNode.js';
import { END } from '../contracts/graph/index.js';

/**
 * State for Reflection pattern execution.
 */
export interface ReflectionState extends GraphState {
    /** The task or prompt */
    task: string;
    /** Current draft/solution */
    draft: string;
    /** Critique feedback */
    critique: string;
    /** Quality score (0-10) */
    quality: number;
    /** Refinement iteration count */
    iteration: number;
    /** History of previous drafts (optional) */
    history?: string[];
}

/**
 * Configuration for Reflection pattern.
 */
export interface ReflectionConfig extends PatternConfig<ReflectionState> {
    /** Minimum quality score to accept (0-10, default: 8) */
    qualityThreshold?: number;
    /** Maximum refinement rounds (default: 3) */
    maxRounds?: number;
    /** Whether to keep draft history (default: false) */
    keepHistory?: boolean;
}

/**
 * Creates a Reflection / Self-Critique agent.
 *
 * The agent generates a draft solution, critiques it for quality and issues,
 * then refines iteratively until the quality threshold is met or max rounds
 * are exhausted.
 *
 * @example
 * ```ts
 * const agent = createReflectionAgent({
 *   llm: myLlm,
 *   qualityThreshold: 8,
 *   maxRounds: 3,
 * });
 *
 * const result = await agent.run({
 *   task: 'Write a haiku about recursion',
 *   draft: '', critique: '', quality: 0, iteration: 0,
 * });
 * console.log(result.state.draft); // Final refined output
 * ```
 */
export function createReflectionAgent(config: ReflectionConfig): IGraphEngine<ReflectionState> {
    const qualityThreshold = config.qualityThreshold ?? 8;
    const maxRounds = config.maxRounds ?? 3;
    const keepHistory = config.keepHistory ?? false;

    // Generator node: create or refine the draft
    const generator = new LlmGraphNode<ReflectionState>({
        id: 'generate',
        provider: config.llm,
        prompt: (state) => {
            if (state.iteration === 0) {
                return {
                    instructions: 'Generate a high-quality solution to the task.',
                    text: state.task,
                };
            }

            return {
                instructions: `Refine your previous draft based on the critique.

Previous draft:
${state.draft}

Critique:
${state.critique}

Generate an IMPROVED version addressing the feedback.`,
                text: state.task,
            };
        },
        outputKey: 'draft',
        temperature: 0.7,
    });

    // Save draft to history if enabled
    const saveHistory = new CallbackGraphNode<ReflectionState>('save_history', async (state) => {
        if (keepHistory) {
            if (!state.history) state.history = [];
            state.history.push(state.draft);
        }
    });

    // Critic node: evaluate the draft
    const critic = new LlmGraphNode<ReflectionState>({
        id: 'critique',
        provider: config.llm,
        prompt: (state) => ({
            instructions: `Critique the following solution. Rate its quality from 0-10 and provide specific feedback.

Task: ${state.task}

Solution:
${state.draft}

Respond with JSON:
{
  "quality": <number 0-10>,
  "feedback": "<specific issues and suggestions>",
  "strengths": "<what works well>"
}`,
            text: '',
            schema: {
                type: 'object',
                properties: {
                    quality: { type: 'number' },
                    feedback: { type: 'string' },
                    strengths: { type: 'string' },
                },
                required: ['quality', 'feedback'],
            },
        }),
        outputKey: 'critique',
        temperature: 0.3, // Lower temperature for more consistent evaluation
    });

    // Judge node: parse quality and increment iteration
    const judge = new CallbackGraphNode<ReflectionState>('judge', async (state) => {
        try {
            const parsed = typeof state.critique === 'string'
                ? JSON.parse(state.critique)
                : state.critique;

            state.quality = parsed.quality ?? 5;

            // Keep the full critique text for next iteration
            if (typeof state.critique !== 'string') {
                state.critique = JSON.stringify(parsed, null, 2);
            }
        } catch {
            // If parsing fails, try to extract quality number
            const match = String(state.critique).match(/quality[:\s]+(\d+(?:\.\d+)?)/i);
            state.quality = match ? parseFloat(match[1]) : 5;
        }

        state.iteration++;
    });

    return new StateGraphBuilder<ReflectionState>()
        .addNode(generator)
        .addNode(saveHistory)
        .addNode(critic)
        .addNode(judge)
        .setEntry('generate')
        .addEdge('generate', 'save_history')
        .addEdge('save_history', 'critique')
        .addEdge('critique', 'judge')
        .addConditionalEdge('judge', (state) => {
            // Stop if quality threshold met or max rounds exceeded
            if (state.quality >= qualityThreshold) return END;
            if (state.iteration >= maxRounds) return END;
            return 'generate';
        })
        .build({
            maxSteps: maxRounds * 4,
            tracer: config.tracer,
        });
}
