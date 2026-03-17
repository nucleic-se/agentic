/**
 * State-primary graph engine contracts.
 *
 * A directed graph of nodes sharing a typed mutable state object.
 * Nodes read/write state; edges (static or conditional) determine
 * execution order. Designed for LLM agent workflows: plan → act →
 * observe → decide loops with conditional routing and cycle safety.
 *
 * Generic over TState so domains define their own typed state shape.
 *
 * @module contracts/graph
 */

import type { ITracer } from '../IObservability.js';

// ── State Constraint ───────────────────────────────────────────

/** Base constraint for graph state — a plain object with string keys. */
export type GraphState = Record<string, unknown>;

// ── Sentinel ───────────────────────────────────────────────────

/** Sentinel value indicating the graph should stop execution. */
export const END = '__END__' as const;

/** The literal type of the END sentinel. */
export type GraphEnd = typeof END;

// ── Node ───────────────────────────────────────────────────────

/** Retry policy for a graph node. */
export interface NodeRetryPolicy {
    maxRetries: number;
    initialDelayMs: number;
    /** Multiplier applied to delay after each retry. Default: 2.0. */
    backoffMultiplier?: number;
    /** Only retry on these error types (matched by error.name). Default: all. */
    retryOn?: string[];
}

/**
 * A unit of work in the graph. Reads and mutates shared state.
 *
 * Nodes are deliberately simple — a named async function over state.
 * Compose complex behaviour via the graph topology, not node internals.
 *
 * @typeParam TState - The shape of the shared state object.
 */
export interface IGraphNode<TState extends GraphState = GraphState> {
    /** Unique identifier. Must be non-empty and unique within a graph. */
    readonly id: string;

    /** Optional retry policy — retries with backoff before routing to DLQ. */
    readonly retryPolicy?: NodeRetryPolicy;

    /** Optional timeout in ms — abort node execution if exceeded. */
    readonly timeoutMs?: number;

    /**
     * Execute this node's logic.
     * Mutate `state` in place; the engine snapshots it after completion.
     */
    process(state: TState, context: GraphContext<TState>): Promise<void>;
}

// ── Context ────────────────────────────────────────────────────

/**
 * Execution context passed to every node invocation.
 * Provides observability and positional information.
 * All fields are readonly — nodes cannot modify the context.
 */
export interface GraphContext<TState extends GraphState = GraphState> {
    /** ID of the node currently executing. */
    readonly nodeId: string;

    /** Number of node executions completed so far in this run (0-based). */
    readonly stepCount: number;

    /** Tracer for structured observability. */
    readonly tracer: ITracer;

    /** Correlation ID propagated from engine config. */
    readonly correlationId: string;

    /**
     * Report tool call(s) made during this node's execution.
     * The engine uses this to enforce `GraphRunLimits.maxToolCalls`.
     * Defaults to 1 if called with no argument.
     */
    readonly reportToolCall: (count?: number) => void;

    /**
     * Report token usage consumed during this node's execution.
     * The engine uses this to enforce `GraphRunLimits.maxTotalTokens`.
     */
    readonly reportTokens: (count: number) => void;
}

// ── Edges ──────────────────────────────────────────────────────

/**
 * Router function for conditional edges.
 * Inspects the current state and returns the next node ID, or END to stop.
 *
 * Prefer keeping routers as simple state reads. Use `AsyncRouterFn` only
 * when the routing decision genuinely requires I/O.
 */
export type RouterFn<TState extends GraphState = GraphState> =
    (state: Readonly<TState>) => string | GraphEnd;

/**
 * Async variant for routing decisions that require I/O
 * (database lookups, lightweight LLM calls, external service checks).
 */
export type AsyncRouterFn<TState extends GraphState = GraphState> =
    (state: Readonly<TState>) => Promise<string | GraphEnd>;

// ── Graph (structure) ──────────────────────────────────────────

/**
 * The graph topology: nodes + edges.
 *
 * Invariants:
 * - Node IDs are unique and non-empty.
 * - Each node has at most one outbound edge (static or conditional).
 * - Edge targets must reference existing nodes (or END).
 * - No outbound edge = implicit END.
 */
export interface IGraph<TState extends GraphState = GraphState> {
    /** Register a node. Throws on duplicate or empty ID. */
    addNode(node: IGraphNode<TState>): void;

    /** Add a static edge from one node to another (or END). */
    addEdge(from: string, to: string | GraphEnd): void;

    /** Add a conditional edge — router function decides the target at runtime. */
    addConditionalEdge(from: string, router: RouterFn<TState> | AsyncRouterFn<TState>): void;

    /** Designate the entry point. Must reference an existing node. */
    setEntry(nodeId: string): void;

    /** Retrieve a node by ID, or undefined if not found. */
    getNode(id: string): IGraphNode<TState> | undefined;

    /** Get the static edge target for a node, or undefined. */
    getStaticEdge(from: string): string | GraphEnd | undefined;

    /** Get the conditional edge router for a node, or undefined. */
    getConditionalEdge(from: string): RouterFn<TState> | AsyncRouterFn<TState> | undefined;

    /** Get the entry node ID, or undefined if not set. */
    getEntryNodeId(): string | undefined;

    /**
     * Add a parallel edge that fans out to multiple nodes.
     * All targets execute concurrently; results are merged into state
     * using the provided merge function before the graph continues.
     *
     * @param from    Source node
     * @param targets Nodes to execute in parallel
     * @param merge   Merge concurrent state mutations into a single state
     * @param then    Node to execute after merge (or END)
     */
    addParallelEdge(
        from: string,
        targets: string[],
        merge: ParallelMergeFn<TState>,
        then: string | GraphEnd,
    ): void;

    /** Get the parallel edge descriptor for a node, or undefined. */
    getParallelEdge(from: string): ParallelEdge<TState> | undefined;

    /** List all registered nodes (insertion order). */
    getNodes(): IGraphNode<TState>[];

    /**
     * Validate the graph structure.
     * Returns an array of human-readable error strings. Empty = valid.
     */
    validate(): string[];
}

// ── Engine (execution) ─────────────────────────────────────────

/** A deep-cloned snapshot of state captured after a node completes. */
export interface GraphSnapshot<TState> {
    /** ID of the node that just completed. */
    readonly nodeId: string;
    /** Deep clone of state at this point. */
    readonly state: TState;
    /** Timestamp (ms since epoch) when the snapshot was taken. */
    readonly timestamp: number;
}

/** Result returned by a completed graph run. */
export interface GraphRunResult<TState> {
    /** Final state after all nodes have executed. */
    readonly state: TState;
    /** Ordered snapshots — one per executed node. */
    readonly snapshots: readonly GraphSnapshot<TState>[];
    /** Total number of node executions. */
    readonly steps: number;
}

/** Captured info for a node that threw an unrecoverable error. */
export interface GraphDeadLetter<TState = unknown> {
    /** The error that was thrown. */
    readonly error: Error;
    /** ID of the node that failed. */
    readonly nodeId: string;
    /** State snapshot taken *before* the failing node ran. */
    readonly state: TState;
    /** Timestamp (ms since epoch) when the error occurred. */
    readonly timestamp: number;
}

// ── Checkpoint ─────────────────────────────────────────────────

/** Serialisable snapshot of graph execution state for resume. */
export interface GraphCheckpoint<TState> {
    readonly checkpointId: string;
    readonly correlationId: string;
    readonly currentNodeId: string;
    readonly stepCount: number;
    readonly state: TState;
    readonly timestamp: number;
}

// ── Parallel Edge ──────────────────────────────────────────────

/**
 * Merge function for parallel edge execution.
 * Receives the array of states produced by each parallel branch
 * and returns a single merged state.
 */
export type ParallelMergeFn<TState extends GraphState = GraphState> =
    (states: TState[]) => TState;

/** Descriptor stored for a parallel edge. */
export interface ParallelEdge<TState extends GraphState = GraphState> {
    readonly targets: string[];
    readonly merge: ParallelMergeFn<TState>;
    readonly then: string | GraphEnd;
}

// ── Limits ─────────────────────────────────────────────────────

/** Hard limits enforced across an entire graph run. */
export interface GraphRunLimits {
    /** Max total tool executions across the entire run. */
    maxToolCalls?: number;
    /** Max total wall-clock ms for the entire run. */
    maxTotalMs?: number;
    /** Max total LLM tokens across all LlmGraphNode calls in the run. */
    maxTotalTokens?: number;
}

/** Configuration for the graph engine. */
export interface GraphEngineConfig {
    /** Maximum node executions before aborting (cycle safety). Default: 100. */
    maxSteps?: number;
    /** Tracer instance for structured observability. */
    tracer?: ITracer;
    /** Correlation ID for all trace events emitted during this engine's runs. Defaults to a random UUID. */
    correlationId?: string;
    /** Hard limits for the entire run (tools, time, tokens). */
    limits?: GraphRunLimits;
    /** Called before a node executes. */
    onBeforeNode?: (nodeId: string, state: Readonly<GraphState>, stepCount: number) => void | Promise<void>;
    /** Called after a node executes successfully. */
    onAfterNode?: (nodeId: string, state: Readonly<GraphState>, stepCount: number) => void | Promise<void>;
}

/** Result of a single step execution. */
export interface GraphStepResult<TState> {
    /** The node that was executed. */
    readonly executedNodeId: string;
    /** ID of the next node to execute, or END if the graph is done. */
    readonly nextNodeId: string | GraphEnd;
    /** Snapshot taken after the node executed. */
    readonly snapshot: GraphSnapshot<TState>;
    /** Whether the graph has terminated (nextNodeId === END). */
    readonly done: boolean;
}

/**
 * Executes a graph against an initial state.
 *
 * The engine never mutates the caller's state object — it clones first.
 * After completion, `deadLetterQueue` holds details on any failed nodes.
 */
export interface IGraphEngine<TState extends GraphState = GraphState> {
    /** Run the graph from its entry node with the given initial state. */
    run(initialState: TState): Promise<GraphRunResult<TState>>;

    /**
     * Execute a single node.
     *
     * The caller manages the execution loop — useful for interleaving
     * graph execution with external work (e.g. one-node-per-tick).
     *
     * State is mutated in place (no clone). The caller is responsible
     * for cloning if isolation is needed.
     *
     * @param state     Mutable state object.
     * @param nodeId    The node to execute.
     * @param stepCount Steps completed so far (for context and maxSteps).
     */
    step(state: TState, nodeId: string, stepCount?: number): Promise<GraphStepResult<TState>>;

    /** Capture current execution state as a serialisable checkpoint. */
    checkpoint(state: TState, currentNodeId: string, stepCount: number): GraphCheckpoint<TState>;

    /** Resume execution from a previously captured checkpoint. */
    resume(checkpoint: GraphCheckpoint<TState>): Promise<GraphRunResult<TState>>;

    /** Errors captured during execution — survives across multiple runs. */
    readonly deadLetterQueue: readonly GraphDeadLetter<TState>[];
}

// ── Builder ────────────────────────────────────────────────────

/** Fluent builder for constructing a graph and its engine. */
export interface IGraphBuilder<TState extends GraphState = GraphState> {
    addNode(node: IGraphNode<TState>): IGraphBuilder<TState>;
    addEdge(from: string, to: string | GraphEnd): IGraphBuilder<TState>;
    addConditionalEdge(from: string, router: RouterFn<TState> | AsyncRouterFn<TState>): IGraphBuilder<TState>;
    addParallelEdge(
        from: string,
        targets: string[],
        merge: ParallelMergeFn<TState>,
        then: string | GraphEnd,
    ): IGraphBuilder<TState>;
    setEntry(nodeId: string): IGraphBuilder<TState>;

    /**
     * Build and return an engine for executing the graph.
     * Validates the graph; throws if the structure is invalid.
     */
    build(config?: GraphEngineConfig): IGraphEngine<TState>;
}
