/**
 * Supervisor-Worker Pattern
 *
 * A supervisor agent delegates tasks to specialized worker agents,
 * aggregates results, and decides on next steps.
 *
 * Flow: supervise → route to worker → aggregate → (continue or finish)
 *
 * @module patterns/supervisor-worker
 */

import type { GraphState, IGraphEngine } from '../contracts/index.js';
import type { PatternConfig } from './types.js';
import { StateGraphBuilder } from '../runtime/graph/StateGraphBuilder.js';
import { LlmGraphNode } from '../runtime/graph/nodes/LlmGraphNode.js';
import { CallbackGraphNode } from '../runtime/graph/nodes/CallbackGraphNode.js';
import { SubGraphNode } from '../runtime/graph/nodes/SubGraphNode.js';
import { END } from '../contracts/graph/index.js';

/**
 * Worker agent definition.
 */
export interface WorkerAgent<TWorkerState extends GraphState> {
    /** Unique worker ID */
    id: string;
    /** Worker's specialized capability description */
    capability: string;
    /** Worker's graph engine */
    engine: IGraphEngine<TWorkerState>;
    /** Map parent state to worker state */
    input: (parent: SupervisorState) => TWorkerState;
    /** Map worker state back to parent */
    output: (worker: TWorkerState, parent: SupervisorState) => void;
}

/**
 * State for Supervisor-Worker pattern execution.
 */
export interface SupervisorState extends GraphState {
    /** The overall task/goal */
    task: string;
    /** Worker to delegate to next */
    nextWorker: string;
    /** Results from each worker */
    workerResults: Record<string, string>;
    /** Aggregated/final result */
    result: string;
    /** Current iteration */
    iteration: number;
}

/**
 * Configuration for Supervisor-Worker pattern.
 */
export interface SupervisorWorkerConfig extends PatternConfig<SupervisorState> {
    /** Available worker agents */
    workers: WorkerAgent<any>[];
    /** Maximum delegation rounds (default: 5) */
    maxRounds?: number;
}

/**
 * Creates a Supervisor-Worker agent system.
 *
 * The supervisor coordinates multiple specialized worker agents,
 * delegating subtasks and aggregating results.
 *
 * @example
 * ```ts
 * const researchWorker: WorkerAgent<ResearchState> = {
 *   id: 'researcher',
 *   capability: 'Research and gather information',
 *   engine: createReActAgent({ llm, tools: researchTools }),
 *   input: (parent) => ({
 *     goal: parent.task,
 *     // ... other state
 *   }),
 *   output: (worker, parent) => {
 *     parent.workerResults['researcher'] = worker.answer;
 *   },
 * };
 *
 * const agent = createSupervisorAgent({
 *   llm: myLlm,
 *   workers: [researchWorker, writerWorker, editorWorker],
 * });
 * ```
 */
export function createSupervisorAgent(
    config: SupervisorWorkerConfig,
): IGraphEngine<SupervisorState> {
    const maxRounds = config.maxRounds ?? 5;
    const workerMap = new Map(config.workers.map(w => [w.id, w]));

    // Supervisor: decide which worker to delegate to
    const supervisor = new LlmGraphNode<SupervisorState>({
        id: 'supervise',
        provider: config.llm,
        prompt: (state) => {
            const workerList = config.workers
                .map(w => `- ${w.id}: ${w.capability}`)
                .join('\n');

            const resultsText = Object.keys(state.workerResults).length > 0
                ? `\n\nWork completed so far:\n${Object.entries(state.workerResults)
                    .map(([id, result]) => `${id}: ${result}`)
                    .join('\n')}`
                : '';

            return {
                instructions: `You are a supervisor coordinating specialized workers.

Task: ${state.task}

Available workers:
${workerList}
${resultsText}

Decide which worker should act next, or use "FINISH" if the task is complete.

Respond with JSON:
{
  "nextWorker": "worker_id or FINISH",
  "reasoning": "why this worker"
}`,
                text: '',
                schema: {
                    type: 'object',
                    properties: {
                        nextWorker: { type: 'string' },
                        reasoning: { type: 'string' },
                    },
                    required: ['nextWorker'],
                },
            };
        },
        outputKey: 'nextWorker',
        temperature: 0.5,
    });

    // Parse supervisor decision
    const parseSupervisor = new CallbackGraphNode<SupervisorState>(
        'parse_supervisor',
        async (state) => {
            try {
                const parsed = typeof state.nextWorker === 'string'
                    ? JSON.parse(state.nextWorker)
                    : state.nextWorker;

                state.nextWorker = parsed.nextWorker || 'FINISH';
            } catch {
                // If parsing fails, check string content
                if (String(state.nextWorker).includes('FINISH')) {
                    state.nextWorker = 'FINISH';
                }
            }

            // Increment iteration here (state is mutable in nodes)
            state.iteration++;
        },
    );

    // Aggregator: combine worker results when finished
    const aggregator = new LlmGraphNode<SupervisorState>({
        id: 'aggregate',
        provider: config.llm,
        prompt: (state) => ({
            instructions: `Synthesize the worker outputs into a final cohesive result.

Original task: ${state.task}

Worker outputs:
${Object.entries(state.workerResults)
                .map(([id, result]) => `${id}:\n${result}`)
                .join('\n\n')}

Provide a clear, complete final answer.`,
            text: '',
        }),
        outputKey: 'result',
        temperature: 0.3,
    });

    const builder = new StateGraphBuilder<SupervisorState>()
        .addNode(supervisor)
        .addNode(parseSupervisor)
        .addNode(aggregator)
        .setEntry('supervise')
        .addEdge('supervise', 'parse_supervisor');

    // Add each worker as a SubGraphNode
    for (const worker of config.workers) {
        const workerNode = new SubGraphNode<SupervisorState, any>({
            id: worker.id,
            engine: worker.engine,
            input: worker.input,
            output: worker.output,
        });

        builder.addNode(workerNode);

        // Connect worker back to supervisor
        builder.addEdge(worker.id, 'supervise');
    }

    // Route from parse_supervisor to the appropriate worker or aggregator
    builder.addConditionalEdge('parse_supervisor', (state) => {
        // Stop if max rounds exceeded
        if (state.iteration >= maxRounds) {
            return 'aggregate';
        }

        // Stop if supervisor says FINISH
        if (state.nextWorker === 'FINISH') {
            return 'aggregate';
        }

        // Route to the selected worker
        if (workerMap.has(state.nextWorker)) {
            return state.nextWorker;
        }

        // Unknown worker — go to aggregator
        return 'aggregate';
    });

    return builder.build({
        maxSteps: maxRounds * 10,
        tracer: config.tracer,
    });
}
