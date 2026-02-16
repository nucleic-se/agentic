/**
 * State graph engine — executes a graph against shared state.
 *
 * Execution model:
 * 1. Clone initial state (caller's object is never mutated).
 * 2. Start at the entry node.
 * 3. Run node.process(state, context) — node mutates state in place.
 * 4. Snapshot state after each node (deep clone for replay/debug).
 * 5. Resolve next node: conditional edge → static edge → implicit END.
 * 6. Repeat until END or maxSteps exceeded.
 *
 * Error handling:
 * - Node errors are caught and pushed to the dead letter queue with
 *   a pre-execution state snapshot, then re-thrown so the caller can
 *   decide recovery strategy.
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

    constructor(graph: IGraph<TState>, config?: GraphEngineConfig) {
        if (!graph) {
            throw new Error('StateGraphEngine: graph is required.');
        }
        this.graph = graph;
        this.maxSteps = config?.maxSteps ?? 100;
        this.tracer = config?.tracer ?? noopTracer;

        if (this.maxSteps < 1) {
            throw new Error(`StateGraphEngine: maxSteps must be ≥ 1, got ${this.maxSteps}.`);
        }
    }

    /** Read-only view of the dead letter queue. */
    get deadLetterQueue(): readonly GraphDeadLetter<TState>[] {
        return this._deadLetterQueue;
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
            if (steps >= this.maxSteps) {
                throw new Error(
                    `Max steps (${this.maxSteps}) exceeded at node '${currentNodeId}'. Possible infinite loop.`,
                );
            }

            const node = this.graph.getNode(currentNodeId);
            if (!node) {
                throw new Error(
                    `Node '${currentNodeId}' not found in graph (step ${steps}). ` +
                    'This likely means a conditional edge returned an invalid node ID.',
                );
            }

            // Snapshot state before execution (for DLQ on failure)
            const preSnapshot = structuredClone(state);

            const context: GraphContext<TState> = Object.freeze({
                nodeId: currentNodeId,
                stepCount: steps,
                tracer: this.tracer,
            });

            try {
                await node.process(state, context);
            } catch (error) {
                this.recordError(currentNodeId, error as Error, preSnapshot, steps);
                throw error;
            }

            steps++;

            // Snapshot state after successful execution
            snapshots.push(Object.freeze({
                nodeId: currentNodeId,
                state: structuredClone(state),
                timestamp: Date.now(),
            }));

            this.tracer.trace({
                simulationId: 'graph',
                type: 'graph.step',
                timestamp: Date.now(),
                data: { nodeId: currentNodeId, step: steps },
            });

            // Resolve next node (router errors are caught separately)
            try {
                currentNodeId = this.resolveNext(currentNodeId, state);
            } catch (error) {
                this.recordError(currentNodeId, error as Error, structuredClone(state), steps);
                throw error;
            }
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
            simulationId: 'graph',
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
