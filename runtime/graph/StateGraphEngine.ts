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
    IGraphNode,
    GraphContext,
    GraphRunResult,
    GraphSnapshot,
    GraphStepResult,
    GraphDeadLetter,
    GraphCheckpoint,
    GraphEngineConfig,
    OrchestratorLimits,
    GraphEnd,
    GraphState,
} from '../../contracts/graph/index.js';
import { END } from '../../contracts/graph/index.js';
import type { ITracer, ISpanTracer } from '../../contracts/IObservability.js';
import { randomUUID } from 'node:crypto';

/** Minimal no-op tracer used when none is supplied. */
const noopTracer: ITracer = {
    trace() {},
    recent() { return []; },
};

/** Returns true when `tracer` also implements the span-tracing extension. */
function isSpanTracer(tracer: ITracer): tracer is ISpanTracer {
    return typeof (tracer as unknown as ISpanTracer).startSpan === 'function';
}

export class StateGraphEngine<TState extends GraphState = GraphState>
    implements IGraphEngine<TState>
{
    private readonly _deadLetterQueue: GraphDeadLetter<TState>[] = [];
    private readonly graph: IGraph<TState>;
    private readonly maxSteps: number;
    private readonly tracer: ITracer;
    private readonly correlationId: string;
    private readonly limits?: OrchestratorLimits;
    private readonly onBeforeNode?: GraphEngineConfig['onBeforeNode'];
    private readonly onAfterNode?: GraphEngineConfig['onAfterNode'];

    // Per-run accumulators — reset at the start of each run() / resume().
    private _toolCallCount = 0;
    private _tokenCount = 0;
    /** Span ID of the root span opened by the current run(). Undefined outside a run. */
    private _activeRootSpanId: string | undefined = undefined;

    constructor(graph: IGraph<TState>, config?: GraphEngineConfig) {
        if (!graph) {
            throw new Error('StateGraphEngine: graph is required.');
        }
        this.graph = graph;
        this.maxSteps = config?.maxSteps ?? 100;
        this.tracer = config?.tracer ?? noopTracer;
        this.correlationId = config?.correlationId ?? randomUUID();
        this.limits = config?.limits;
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
            correlationId: this.correlationId,
            reportToolCall: (count = 1) => { this._toolCallCount += count; },
            reportTokens: (count: number) => { this._tokenCount += count; },
        });

        // Open a child span if the tracer supports it.
        let nodeSpanId: string | undefined;
        if (isSpanTracer(this.tracer)) {
            nodeSpanId = this.tracer.startSpan({
                correlationId: this.correlationId,
                parentSpanId: this._activeRootSpanId,
                type: `node.${nodeId}`,
                startTime: Date.now(),
                metadata: { nodeId, stepCount },
            });
        }

        // Before-hook
        await this.onBeforeNode?.(nodeId, state, stepCount);

        try {
            await this.executeWithRetryAndTimeout(node, state, context, preSnapshot);
        } catch (error) {
            if (nodeSpanId && isSpanTracer(this.tracer)) {
                this.tracer.endSpan(nodeSpanId, 'error', (error as Error).message);
            }
            this.recordError(nodeId, error as Error, preSnapshot, stepCount);
            throw error;
        }

        // After-hook
        await this.onAfterNode?.(nodeId, state, stepCount);

        // Close the node span.
        if (nodeSpanId && isSpanTracer(this.tracer)) {
            this.tracer.endSpan(nodeSpanId, 'ok');
        }

        // Snapshot state after successful execution
        const snapshot: GraphSnapshot<TState> = Object.freeze({
            nodeId,
            state: structuredClone(state),
            timestamp: Date.now(),
        });

        this.tracer.trace({
            correlationId: this.correlationId,
            type: 'graph.step',
            timestamp: Date.now(),
            data: { nodeId, step: stepCount },
        });

        // Resolve next node (router errors are caught separately)
        let nextNodeId: string | GraphEnd;
        try {
            nextNodeId = await this.resolveNext(nodeId, state);
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
        const startTime = Date.now();

        // Reset per-run accumulators.
        this._toolCallCount = 0;
        this._tokenCount = 0;

        // Open a root span if the tracer supports it.
        if (isSpanTracer(this.tracer)) {
            this._activeRootSpanId = this.tracer.startSpan({
                correlationId: this.correlationId,
                type: 'graph-run',
                startTime: Date.now(),
                metadata: { entryId },
            });
        }

        try {
            while (currentNodeId !== END) {
                // Enforce wall-clock limit
                if (this.limits?.maxTotalMs != null) {
                    const elapsed = Date.now() - startTime;
                    if (elapsed >= this.limits.maxTotalMs) {
                        throw new Error(
                            `Orchestrator limit exceeded: maxTotalMs (${this.limits.maxTotalMs}ms) reached after ${steps} steps.`,
                        );
                    }
                }

                // Enforce tool-call limit.
                if (this.limits?.maxToolCalls != null && this._toolCallCount >= this.limits.maxToolCalls) {
                    throw new Error(
                        `Orchestrator limit exceeded: maxToolCalls (${this.limits.maxToolCalls}) reached after ${steps} steps.`,
                    );
                }

                // Enforce token limit.
                if (this.limits?.maxTotalTokens != null && this._tokenCount >= this.limits.maxTotalTokens) {
                    throw new Error(
                        `Orchestrator limit exceeded: maxTotalTokens (${this.limits.maxTotalTokens}) reached after ${steps} steps.`,
                    );
                }

                const result = await this.step(state, currentNodeId as string, steps);
                snapshots.push(result.snapshot);
                currentNodeId = result.nextNodeId;
                steps++;
            }
        } catch (error) {
            if (this._activeRootSpanId && isSpanTracer(this.tracer)) {
                this.tracer.endSpan(this._activeRootSpanId, 'error', (error as Error).message);
                this._activeRootSpanId = undefined;
            }
            throw error;
        }

        if (this._activeRootSpanId && isSpanTracer(this.tracer)) {
            this.tracer.endSpan(this._activeRootSpanId, 'ok');
            this._activeRootSpanId = undefined;
        }

        return Object.freeze({ state, snapshots: Object.freeze(snapshots), steps });
    }
    /**
     * Capture current execution state as a serialisable checkpoint.
     * The checkpoint can be persisted and later passed to resume().
     */
    checkpoint(state: TState, currentNodeId: string, stepCount: number): GraphCheckpoint<TState> {
        return Object.freeze({
            checkpointId: randomUUID(),
            correlationId: this.correlationId,
            currentNodeId,
            stepCount,
            state: structuredClone(state),
            timestamp: Date.now(),
        });
    }

    /**
     * Resume execution from a previously captured checkpoint.
     * Continues the graph run from the checkpoint's current node.
     */
    async resume(cp: GraphCheckpoint<TState>): Promise<GraphRunResult<TState>> {
        const node = this.graph.getNode(cp.currentNodeId);
        if (!node) {
            throw new Error(`Resume failed: node '${cp.currentNodeId}' not found in graph.`);
        }

        // Reset per-run accumulators. Resume always gets a fresh budget.
        this._toolCallCount = 0;
        this._tokenCount = 0;

        const state = structuredClone(cp.state);
        const snapshots: GraphSnapshot<TState>[] = [];
        let currentNodeId: string | GraphEnd = cp.currentNodeId;
        // Step counter starts from 0 so the resumed run gets a full maxSteps
        // budget, independent of how many steps ran before the checkpoint.
        let steps = 0;
        const startTime = Date.now();

        while (currentNodeId !== END) {
            if (this.limits?.maxTotalMs != null) {
                const elapsed = Date.now() - startTime;
                if (elapsed >= this.limits.maxTotalMs) {
                    throw new Error(
                        `Orchestrator limit exceeded: maxTotalMs (${this.limits.maxTotalMs}ms) reached after ${steps} steps.`,
                    );
                }
            }

            if (this.limits?.maxToolCalls != null && this._toolCallCount >= this.limits.maxToolCalls) {
                throw new Error(
                    `Orchestrator limit exceeded: maxToolCalls (${this.limits.maxToolCalls}) reached after ${steps} steps.`,
                );
            }

            if (this.limits?.maxTotalTokens != null && this._tokenCount >= this.limits.maxTotalTokens) {
                throw new Error(
                    `Orchestrator limit exceeded: maxTotalTokens (${this.limits.maxTotalTokens}) reached after ${steps} steps.`,
                );
            }

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
     * Priority: parallel edge → conditional edge → static edge → implicit END.
     *
     * For parallel edges, fans out to all targets concurrently, merges
     * results into state, then returns the 'then' node.
     */
    private async resolveNext(currentNodeId: string, state: TState): Promise<string | GraphEnd> {
        // Parallel edge: fan-out, merge, continue
        const parallel = this.graph.getParallelEdge(currentNodeId);
        if (parallel) {
            const branchStates = await Promise.all(
                parallel.targets.map(async (targetId) => {
                    const branchState = structuredClone(state);
                    const node = this.graph.getNode(targetId);
                    if (!node) {
                        throw new Error(`Parallel target node '${targetId}' not found.`);
                    }
                    const context: GraphContext<TState> = Object.freeze({
                        nodeId: targetId,
                        stepCount: -1, // parallel branches don't count as top-level steps
                        tracer: this.tracer,
                        correlationId: this.correlationId,
                        reportToolCall: (count = 1) => { this._toolCallCount += count; },
                        reportTokens: (count: number) => { this._tokenCount += count; },
                    });
                    // Fire hooks and use the same retry+timeout logic as sequential nodes.
                    await this.onBeforeNode?.(targetId, branchState, -1);
                    await this.executeWithRetryAndTimeout(node, branchState, context, branchState);
                    await this.onAfterNode?.(targetId, branchState, -1);
                    return branchState;
                }),
            );
            const merged = parallel.merge(branchStates);
            Object.assign(state, merged);
            return parallel.then;
        }

        const conditional = this.graph.getConditionalEdge(currentNodeId);
        if (conditional) {
            const next = await conditional(state);
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

    /**
     * Execute a node with its retry policy and timeout, restoring state
     * from `preSnapshot` between retry attempts to undo partial mutations.
     *
     * Throws the last error if all attempts fail. Does NOT record to DLQ —
     * that responsibility stays with the caller.
     */
    private async executeWithRetryAndTimeout(
        node: IGraphNode<TState>,
        state: TState,
        context: GraphContext<TState>,
        preSnapshot: TState,
    ): Promise<void> {
        const retryPolicy = node.retryPolicy;
        const maxAttempts = retryPolicy ? retryPolicy.maxRetries + 1 : 1;
        let lastError: Error | undefined;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            // Restore state from pre-snapshot on retry to undo partial mutations.
            if (attempt > 0) {
                Object.assign(state, structuredClone(preSnapshot));
            }

            try {
                if (node.timeoutMs != null && node.timeoutMs > 0) {
                    await Promise.race([
                        node.process(state, context),
                        new Promise<never>((_, reject) =>
                            setTimeout(
                                () => reject(new Error(`Node '${node.id}' timed out after ${node.timeoutMs}ms`)),
                                node.timeoutMs,
                            ),
                        ),
                    ]);
                } else {
                    await node.process(state, context);
                }
                return; // success
            } catch (error) {
                lastError = error as Error;

                // Stop retrying if this error type is not in the allow-list.
                if (retryPolicy?.retryOn && retryPolicy.retryOn.length > 0) {
                    if (!retryPolicy.retryOn.includes(lastError.name)) {
                        break;
                    }
                }

                // Backoff before the next attempt.
                if (attempt < maxAttempts - 1) {
                    const multiplier = retryPolicy?.backoffMultiplier ?? 2.0;
                    const delay = (retryPolicy?.initialDelayMs ?? 100) * Math.pow(multiplier, attempt);
                    await new Promise(r => setTimeout(r, delay));
                }
            }
        }

        throw lastError;
    }

    /** Record an error in the DLQ and emit a trace event. */
    private recordError(
        nodeId: string,
        error: Error,
        stateSnapshot: TState,
        step: number,
    ): void {
        this.tracer.trace({
            correlationId: this.correlationId,
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
