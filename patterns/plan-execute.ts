/**
 * Plan-Execute Pattern
 *
 * First creates a comprehensive plan, then executes each step sequentially,
 * with optional re-planning based on execution results.
 *
 * Flow: plan → execute step → review → (next step, replan, or finish)
 *
 * @module patterns/plan-execute
 */

import type { GraphState, IGraphEngine } from '../contracts/index.js';
import type { PatternConfig } from './types.js';
import { StateGraphBuilder } from '../runtime/graph/StateGraphBuilder.js';
import { LlmGraphNode } from '../runtime/graph/nodes/LlmGraphNode.js';
import { CallbackGraphNode } from '../runtime/graph/nodes/CallbackGraphNode.js';
import { END } from '../contracts/graph/index.js';

/**
 * State for Plan-Execute pattern execution.
 */
export interface PlanExecuteState extends GraphState {
    /** The objective to achieve */
    objective: string;
    /** List of plan steps */
    plan: string[];
    /** Current step index */
    currentStep: number;
    /** Results from executed steps */
    results: string[];
    /** Review/critique from the reviewer */
    review: string;
    /** Whether to replan */
    shouldReplan: boolean;
}

/**
 * Configuration for Plan-Execute pattern.
 */
export interface PlanExecuteConfig extends PatternConfig<PlanExecuteState> {
    /** Function to execute each plan step */
    executor: (step: string, context: { previousResults: string[] }) => Promise<string>;
    /** Whether to enable review/replanning (default: true) */
    enableReview?: boolean;
}

/**
 * Creates a Plan-Execute agent.
 *
 * The agent first creates a comprehensive plan, then executes each step.
 * After each execution, it can review progress and decide to continue,
 * replan, or finish.
 *
 * @example
 * ```ts
 * const agent = createPlanExecuteAgent({
 *   llm: myLlm,
 *   executor: async (step, ctx) => {
 *     // Execute the step using previous context
 *     return `Completed: ${step}`;
 *   },
 *   enableReview: true,
 * });
 *
 * const result = await agent.run({
 *   objective: 'Research and write a blog post about quantum computing',
 *   plan: [], currentStep: 0, results: [],
 *   review: '', shouldReplan: false,
 * });
 * ```
 */
export function createPlanExecuteAgent(config: PlanExecuteConfig): IGraphEngine<PlanExecuteState> {
    const enableReview = config.enableReview ?? true;

    // Planning node: create a step-by-step plan
    const planner = new LlmGraphNode<PlanExecuteState>({
        id: 'plan',
        provider: config.llm,
        prompt: (state) => ({
            instructions: `Create a detailed step-by-step plan to achieve the objective.
${state.results.length > 0 ? `\nPrevious plan didn't work. Results so far:\n${state.results.join('\n')}\n\nCreate a REVISED plan.` : ''}

Respond with JSON:
{
  "steps": ["step 1", "step 2", ...]
}`,
            text: state.objective,
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
        outputKey: 'plan',
    });

    // Parse plan from LLM output
    const parsePlan = new CallbackGraphNode<PlanExecuteState>('parse_plan', async (state) => {
        // Handle case where LLM returns structured object
        if (typeof state.plan === 'string') {
            try {
                const parsed = JSON.parse(state.plan as unknown as string);
                state.plan = parsed.steps || [];
            } catch {
                // If parse fails, split by lines
                state.plan = (state.plan as unknown as string)
                    .split('\n')
                    .filter(line => line.trim());
            }
        } else if (Array.isArray(state.plan)) {
            // Already an array, keep it
        } else if (typeof state.plan === 'object' && 'steps' in state.plan) {
            state.plan = (state.plan as unknown as { steps: string[] }).steps;
        }

        // Reset execution state when replanning
        if (state.shouldReplan) {
            state.currentStep = 0;
            state.shouldReplan = false;
        }
    });

    // Execution node: execute the current step
    const executor = new CallbackGraphNode<PlanExecuteState>('execute', async (state) => {
        const step = state.plan[state.currentStep];
        const result = await config.executor(step, {
            previousResults: state.results,
        });
        state.results.push(result);
        state.currentStep++;
    });

    // Review node: assess progress and decide next action
    const reviewer = new LlmGraphNode<PlanExecuteState>({
        id: 'review',
        provider: config.llm,
        prompt: (state) => ({
            instructions: `Review the execution progress.

Original objective: ${state.objective}
Plan: ${state.plan.join('\n')}
Progress: ${state.currentStep}/${state.plan.length} steps complete
Results: ${state.results.join('\n')}

Should we:
- CONTINUE: proceed with the next step
- REPLAN: create a new plan
- FINISH: we've achieved the objective

Respond with JSON:
{
  "decision": "CONTINUE | REPLAN | FINISH",
  "reasoning": "explanation"
}`,
            text: '',
            schema: {
                type: 'object',
                properties: {
                    decision: { type: 'string' },
                    reasoning: { type: 'string' },
                },
                required: ['decision'],
            },
        }),
        outputKey: 'review',
    });

    // Parse review decision
    const parseReview = new CallbackGraphNode<PlanExecuteState>('parse_review', async (state) => {
        try {
            const parsed = typeof state.review === 'string'
                ? JSON.parse(state.review)
                : state.review;
            const decision = parsed.decision || '';

            if (decision.includes('REPLAN')) {
                state.shouldReplan = true;
            }
        } catch {
            // Default: continue if not done
        }
    });

    const builder = new StateGraphBuilder<PlanExecuteState>()
        .addNode(planner)
        .addNode(parsePlan)
        .addNode(executor)
        .setEntry('plan')
        .addEdge('plan', 'parse_plan')
        .addEdge('parse_plan', 'execute');

    if (enableReview) {
        builder
            .addNode(reviewer)
            .addNode(parseReview)
            .addEdge('execute', 'review')
            .addEdge('review', 'parse_review')
            .addConditionalEdge('parse_review', (state) => {
                if (state.shouldReplan) return 'plan';
                if (state.currentStep >= state.plan.length) return END;

                const reviewText = typeof state.review === 'string'
                    ? state.review
                    : JSON.stringify(state.review);
                if (reviewText.includes('FINISH')) return END;

                return 'execute';
            });
    } else {
        // Without review, just loop through steps
        builder.addConditionalEdge('execute', (state) =>
            state.currentStep >= state.plan.length ? END : 'execute',
        );
    }

    return builder.build({
        maxSteps: (config.maxIterations ?? 20) * (enableReview ? 5 : 2),
        tracer: config.tracer,
    });
}
