/**
 * Human-in-the-Loop Pattern
 *
 * Incorporates human feedback at critical decision points during
 * agent execution.
 *
 * Flow: agent action → request human input → incorporate feedback → continue
 *
 * @module patterns/human-in-loop
 */

import type { GraphState, IGraphEngine } from '../contracts/index.js';
import type { PatternConfig, HumanInputFunction } from './types.js';
import { StateGraphBuilder } from '../runtime/graph/StateGraphBuilder.js';
import { LlmGraphNode } from '../runtime/graph/nodes/LlmGraphNode.js';
import { CallbackGraphNode } from '../runtime/graph/nodes/CallbackGraphNode.js';
import { END } from '../contracts/graph/index.js';

/**
 * State for Human-in-the-Loop pattern execution.
 */
export interface HumanInLoopState extends GraphState {
    /** The task or goal */
    task: string;
    /** Agent's proposal/draft */
    proposal: string;
    /** Human feedback */
    humanFeedback: string;
    /** Whether human approved */
    approved: boolean;
    /** Final result incorporating feedback */
    result: string;
    /** Iteration count */
    iteration: number;
}

/**
 * Configuration for Human-in-the-Loop pattern.
 */
export interface HumanInLoopConfig extends PatternConfig<HumanInLoopState> {
    /** Function to request human input */
    requestHumanInput: HumanInputFunction;
    /** Maximum refinement iterations (default: 3) */
    maxIterations?: number;
    /** Auto-approve after max iterations (default: false) */
    autoApprove?: boolean;
}

/**
 * Creates a Human-in-the-Loop agent.
 *
 * The agent generates proposals, requests human feedback, and refines
 * based on input until approved or max iterations reached.
 *
 * @example
 * ```ts
 * const agent = createHumanInLoopAgent({
 *   llm: myLlm,
 *   requestHumanInput: async (prompt) => {
 *     // Show prompt to user, wait for response
 *     return await getUserInput(prompt);
 *   },
 *   maxIterations: 3,
 * });
 *
 * const result = await agent.run({
 *   task: 'Draft an email to the team',
 *   proposal: '', humanFeedback: '', approved: false,
 *   result: '', iteration: 0,
 * });
 * ```
 */
export function createHumanInLoopAgent(
    config: HumanInLoopConfig,
): IGraphEngine<HumanInLoopState> {
    const maxIterations = config.maxIterations ?? 3;
    const autoApprove = config.autoApprove ?? false;

    // Generator: create initial proposal or refine based on feedback
    const generator = new LlmGraphNode<HumanInLoopState>({
        id: 'generate',
        provider: config.llm,
        prompt: (state) => {
            if (state.iteration === 0) {
                return {
                    instructions: 'Generate a high-quality response to the task.',
                    text: state.task,
                };
            }

            return {
                instructions: `Revise your previous proposal based on human feedback.

Previous proposal:
${state.proposal}

Human feedback:
${state.humanFeedback}

Generate an improved version.`,
                text: state.task,
            };
        },
        outputKey: 'proposal',
        temperature: 0.7,
    });

    // Human review: request feedback from human
    const humanReview = new CallbackGraphNode<HumanInLoopState>(
        'human_review',
        async (state) => {
            const prompt = `Please review the following proposal:

Task: ${state.task}

Proposal:
${state.proposal}

Type "approve" to accept, or provide feedback for improvement:`;

            state.humanFeedback = await config.requestHumanInput(prompt);

            // Check if human approved
            const feedback = state.humanFeedback.toLowerCase().trim();
            state.approved =
                feedback === 'approve' ||
                feedback === 'approved' ||
                feedback === 'lgtm' ||
                feedback === 'ok';

            state.iteration++;

            // Auto-approve if max iterations reached
            if (state.iteration >= maxIterations && autoApprove) {
                state.approved = true;
            }
        },
    );

    // Finalize: set result when approved
    const finalize = new CallbackGraphNode<HumanInLoopState>('finalize', async (state) => {
        state.result = state.proposal;
    });

    return new StateGraphBuilder<HumanInLoopState>()
        .addNode(generator)
        .addNode(humanReview)
        .addNode(finalize)
        .setEntry('generate')
        .addEdge('generate', 'human_review')
        .addConditionalEdge('human_review', (state) => {
            // If approved or max iterations, finalize
            if (state.approved) return 'finalize';
            if (state.iteration >= maxIterations) return 'finalize';

            // Otherwise, refine
            return 'generate';
        })
        .build({
            maxSteps: maxIterations * 3,
            tracer: config.tracer,
        });
}
