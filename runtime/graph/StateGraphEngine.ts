/**
 * State graph engine — executes a graph against shared state.
 *
 * Two execution modes:
 *
 * 1. `run(initialState)` — clone + run to completion (loop of step()).
 * 2. `step(state, nodeId, stepCount)` — execute one node, return cursor.
 *    Caller manages the loop. Useful for one-node-per-tick interleaving.
 *
 * Error handling:
 * - Node errors are caught, pushed to the dead letter queue with
 *   a pre-execution state snapshot, then re-thrown.
 * - Router errors (from conditional edges) are treated the same way.
 *
 * @module runtime/graph
 */

import type {
    IGraph,
    IGraphEngine,
    GraphContext,
    GraphRunResult,
    GraphSnapshot,
    GraphStepResult,
    GraphDeadLetter,
    GraphEngineConfig,
    GraphEnd,
    GraphState,
} from '../../contracts/graph/index.js';
import { END } from '../../contracts/graph/index.js';
import type { ITracer } from '../../contracts/IObservability.js';

/** Minimal no-op tracer used when none is supplied. */
const noopTracer: ITracer = {
    trace() {},
    recent() { return []; },
};

export class StateGraphEngine<TState extends GraphState = GraphState>
    implements IGraphEngine<TState>
{
    private readonly _deadLetterQueue: GraphDeadLetter<TState>[] = [];
    private readonly graph: IGraph<TState>;
    private readonly maxSteps: number;
    private readonly tracer: ITracer;
    private readonly onBeforeNode?: GraphEngineConfig['onBeforeNode'];
    private readonly onAfterNode?: GraphEngineConfig['onAfterNode'];

    constructor(graph: IGraph<TState>, config?: GraphEngineConfig) {
        if (!graph) {
            throw new Error('StateGraphEngine: graph is required.');
        }
        this.graph = graph;
        this.maxSteps = config?.maxSteps ?? 100;
        this.tracer = config?.tracer ?? noopTracer;
        this.onBeforeNode = config?.onBeforeNode;
        this.onAfterNode = config?.onAfterNode;

        if (this.maxSteps < 1) {
            throw new Error(`StateGraphEngine: maxSteps must be ≥ 1, got ${this.maxSteps}.`);
        }
    }

    /** Read-only view of the dead letter queue. */
    get deadLetterQueue(): readonly GraphDeadLetter<TState>[] {
        return this._deadLetterQueue;
    }

    /**
     * Execute a single node. The caller manages the execution loop.
     *
     * State is mutated in place — the caller is responsible for cloning
     * if isolation is needed. A deep-clone snapshot is still taken for
     * the returned GraphStepResult and DLQ.
     */
    async step(state: TState, nodeId: string, stepCount: number = 0): Promise<GraphStepResult<TState>> {
        if (stepCount >= this.maxSteps) {
            throw new Error(
                `Max steps (${this.maxSteps}) exceeded at node '${nodeId}'. Possible infinite loop.`,
            );
        }

        const node = this.graph.getNode(nodeId);
        if (!node) {
            throw new Error(
                `Node '${nodeId}' not found in graph (step ${stepCount}). ` +
                'This likely means a conditional edge returned an invalid node ID.',
            );
        }

        // Snapshot state before execution (for DLQ on failure)
        const preSnapshot = structuredClone(state);

        const context: GraphContext<TState> = Object.freeze({
            nodeId,
            stepCount,
            tracer: this.tracer,
        });

        // Before-hook
        await this.onBeforeNode?.(nodeId, state, stepCount);

        try {
            await node.process(state, context);
        } catch (error) {
            this.recordError(nodeId, error as Error, preSnapshot, stepCount);
            throw error;
        }

        // After-hook
        await this.onAfterNode?.(nodeId, state, stepCount);

        // Snapshot state after successful execution
        const snapshot: GraphSnapshot<TState> = Object.freeze({
            nodeId,
            state: structuredClone(state),
            timestamp: Date.now(),
        });

        this.tracer.trace({
            correlationId: 'graph',
            type: 'graph.step',
            timestamp: Date.now(),
            data: { nodeId, step: stepCount },
        });

        // Resolve next node (router errors are caught separately)
        let nextNodeId: string | GraphEnd;
        try {
            nextNodeId = this.resolveNext(nodeId, state);
        } catch (error) {
            this.recordError(nodeId, error as Error, structuredClone(state), stepCount);
            throw error;
        }

        return Object.freeze({
            executedNodeId: nodeId,
            nextNodeId,
            snapshot,
            done: nextNodeId === END,
        });
    }

    async run(initialState: TState): Promise<GraphRunResult<TState>> {
        const entryId = this.graph.getEntryNodeId();
        if (!entryId) {
            throw new Error('No entry node set. Call setEntry() before running.');
        }
        if (!this.graph.getNode(entryId)) {
            throw new Error(`Entry node '${entryId}' not found in graph.`);
        }

        const state = structuredClone(initialState);
        const snapshots: GraphSnapshot<TState>[] = [];
        let currentNodeId: string | GraphEnd = entryId;
        let steps = 0;

        while (currentNodeId !== END) {
            const result = await this.step(state, currentNodeId as string, steps);
            snapshots.push(result.snapshot);
            currentNodeId = result.nextNodeId;
            steps++;
        }

        return Object.freeze({ state, snapshots: Object.freeze(snapshots), steps });
    }

    // ── Private ────────────────────────────────────────────────

    /**
     * Determines the next node to execute.
     * Priority: conditional edge → static edge → implicit END.
     */
    private resolveNext(currentNodeId: string, state: TState): string | GraphEnd {
        const conditional = this.graph.getConditionalEdge(currentNodeId);
        if (conditional) {
            const next = conditional(state);
            if (typeof next !== 'string') {
                throw new Error(
                    `Router for node '${currentNodeId}' returned ${typeof next} instead of a string.`,
                );
            }
            return next;
        }

        const staticTarget = this.graph.getStaticEdge(currentNodeId);
        if (staticTarget !== undefined) {
            return staticTarget;
        }

        // No outbound edge = implicit END
        return END;
    }

    /** Record an error in the DLQ and emit a trace event. */
    private recordError(
        nodeId: string,
        error: Error,
        stateSnapshot: TState,
        step: number,
    ): void {
        this.tracer.trace({
            correlationId: 'graph',
            type: 'graph.error',
            timestamp: Date.now(),
            data: {
                nodeId,
                step,
                error: error.message,
                stack: error.stack,
            },
        });

        this._deadLetterQueue.push(Object.freeze({
            error,
            nodeId,
            state: stateSnapshot,
            timestamp: Date.now(),
        }));
    }
}
