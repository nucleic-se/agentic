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
}

// ── Edges ──────────────────────────────────────────────────────

/**
 * Router function for conditional edges.
 * Inspects the current state and returns the next node ID, or END to stop.
 *
 * Must be pure (no side effects) and synchronous — routing decisions
 * should be trivial reads of state, not async operations.
 */
export type RouterFn<TState extends GraphState = GraphState> =
    (state: Readonly<TState>) => string | GraphEnd;

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
    addConditionalEdge(from: string, router: RouterFn<TState>): void;

    /** Designate the entry point. Must reference an existing node. */
    setEntry(nodeId: string): void;

    /** Retrieve a node by ID, or undefined if not found. */
    getNode(id: string): IGraphNode<TState> | undefined;

    /** Get the static edge target for a node, or undefined. */
    getStaticEdge(from: string): string | GraphEnd | undefined;

    /** Get the conditional edge router for a node, or undefined. */
    getConditionalEdge(from: string): RouterFn<TState> | undefined;

    /** Get the entry node ID, or undefined if not set. */
    getEntryNodeId(): string | undefined;

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

/** Configuration for the graph engine. */
export interface GraphEngineConfig {
    /** Maximum node executions before aborting (cycle safety). Default: 100. */
    maxSteps?: number;
    /** Tracer instance for structured observability. */
    tracer?: ITracer;
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

    /** Errors captured during execution — survives across multiple runs. */
    readonly deadLetterQueue: readonly GraphDeadLetter<TState>[];
}

// ── Builder ────────────────────────────────────────────────────

/** Fluent builder for constructing a graph and its engine. */
export interface IGraphBuilder<TState extends GraphState = GraphState> {
    addNode(node: IGraphNode<TState>): IGraphBuilder<TState>;
    addEdge(from: string, to: string | GraphEnd): IGraphBuilder<TState>;
    addConditionalEdge(from: string, router: RouterFn<TState>): IGraphBuilder<TState>;
    setEntry(nodeId: string): IGraphBuilder<TState>;

    /**
     * Build and return an engine for executing the graph.
     * Validates the graph; throws if the structure is invalid.
     */
    build(config?: GraphEngineConfig): IGraphEngine<TState>;
}
