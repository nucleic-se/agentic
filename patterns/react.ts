/**
 * ReAct (Reason + Act) Pattern
 *
 * Alternates between reasoning about the next action and executing it,
 * using observations from previous actions to inform future reasoning.
 *
 * Flow: reason → act → observe → (repeat or finish)
 *
 * @module patterns/react
 */

import type { GraphState, IGraphEngine } from '../contracts/index.js';
import type { PatternConfig, ToolRegistry } from './types.js';
import { StateGraphBuilder } from '../runtime/graph/StateGraphBuilder.js';
import { LlmGraphNode } from '../runtime/graph/nodes/LlmGraphNode.js';
import { CallbackGraphNode } from '../runtime/graph/nodes/CallbackGraphNode.js';
import { END } from '../contracts/graph/index.js';

/**
 * State for ReAct pattern execution.
 */
export interface ReActState extends GraphState {
    /** The goal or question to achieve */
    goal: string;
    /** Current reasoning/thought */
    thought: string;
    /** Action to execute (tool name) */
    action: string;
    /** Action parameters */
    actionInput: string;
    /** Result from executing the action */
    observation: string;
    /** Final answer when done */
    answer: string;
    /** Current iteration count */
    iteration: number;
}

/**
 * Configuration for ReAct pattern.
 */
export interface ReActConfig extends PatternConfig<ReActState> {
    /** Available tools the agent can use */
    tools: ToolRegistry;
    /** Maximum reasoning iterations (default: 5) */
    maxIterations?: number;
}

/**
 * Creates a ReAct (Reason + Act) agent.
 *
 * The agent alternates between reasoning about what to do next and executing
 * actions using the provided tools. After each action, it observes the result
 * and uses it to inform the next step of reasoning.
 *
 * @example
 * ```ts
 * const agent = createReActAgent({
 *   llm: myLlm,
 *   tools: {
 *     search: async (q) => `Results for: ${q}`,
 *     calculate: async (expr) => eval(expr).toString(),
 *   },
 *   maxIterations: 5,
 * });
 *
 * const result = await agent.run({
 *   goal: 'What is 15% of 240?',
 *   thought: '', action: '', actionInput: '', observation: '',
 *   answer: '', iteration: 0,
 * });
 * console.log(result.state.answer);
 * ```
 */
export function createReActAgent(config: ReActConfig): IGraphEngine<ReActState> {
    const maxIter = config.maxIterations ?? 5;

    // Reasoning node: decide what to do next
    const reason = new LlmGraphNode<ReActState>({
        id: 'reason',
        provider: config.llm,
        prompt: (state) => {
            const toolList = Object.keys(config.tools).join(', ');
            const history = state.observation
                ? `\n\nPrevious action: ${state.action}\nObservation: ${state.observation}`
                : '';

            return {
                instructions: `You are a helpful agent. Think step-by-step about how to achieve the goal.
Available tools: ${toolList}

Respond with JSON:
{
  "thought": "your reasoning",
  "action": "tool name or FINISH",
  "actionInput": "input for the tool"
}

Use FINISH as the action when you have the final answer.`,
                text: `Goal: ${state.goal}${history}`,
                schema: {
                    type: 'object',
                    properties: {
                        thought: { type: 'string' },
                        action: { type: 'string' },
                        actionInput: { type: 'string' },
                    },
                    required: ['thought', 'action', 'actionInput'],
                },
            };
        },
        outputKey: 'thought',
        model: undefined,
        temperature: 0.7,
    });

    // Parse the LLM response and update state
    const parseReasoning = new CallbackGraphNode<ReActState>('parse', async (state) => {
        try {
            // The LLM should return structured output, but it might be in the thought field
            const parsed = typeof state.thought === 'string'
                ? JSON.parse(state.thought)
                : state.thought;

            state.thought = parsed.thought || '';
            state.action = parsed.action || '';
            state.actionInput = parsed.actionInput || '';
        } catch {
            // If parsing fails, assume thought is literal
            state.action = state.thought.includes('FINISH') ? 'FINISH' : '';
        }
    });

    // Action execution node: run the selected tool
    const act = new CallbackGraphNode<ReActState>('act', async (state) => {
        const tool = config.tools[state.action];
        if (!tool) {
            state.observation = `Error: Unknown tool '${state.action}'`;
            return;
        }

        try {
            state.observation = await tool(state.actionInput);
        } catch (err) {
            state.observation = `Error executing ${state.action}: ${(err as Error).message}`;
        }

        state.iteration++;
    });

    // Decision node: determine if we should continue or finish
    const decide = new CallbackGraphNode<ReActState>('decide', async (state) => {
        // If action was FINISH, extract answer from observation or actionInput
        if (state.action === 'FINISH') {
            state.answer = state.actionInput || state.observation;
        }
    });

    return new StateGraphBuilder<ReActState>()
        .addNode(reason)
        .addNode(parseReasoning)
        .addNode(act)
        .addNode(decide)
        .setEntry('reason')
        .addEdge('reason', 'parse')
        .addConditionalEdge('parse', (state) => {
            // If action is FINISH, skip act and go to decide
            return state.action === 'FINISH' ? 'decide' : 'act';
        })
        .addEdge('act', 'decide')
        .addConditionalEdge('decide', (state) => {
            // Stop if we have an answer or exceeded iterations
            if (state.answer || state.iteration >= maxIter) {
                return END;
            }
            return 'reason';
        })
        .build({
            maxSteps: maxIter * 4, // 4 nodes per iteration
            tracer: config.tracer,
        });
}
