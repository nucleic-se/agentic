/**
 * Sub-graph node — wraps a complete graph engine as a single node.
 *
 * State mapping:
 * - `input(parent)` — extracts/transforms parent state into the
 *   sub-graph's initial state. The parent is not mutated.
 * - `output(subState, parent)` — writes sub-graph results back
 *   into the parent state after the sub-graph completes.
 *
 * The sub-graph runs with its own `maxSteps` budget and DLQ,
 * fully isolated from the parent engine.
 *
 * ```ts
 * const subNode = new SubGraphNode<ArticleState, ResearchState>({
 *     id: 'research',
 *     engine: researchEngine,
 *     input:  (parent) => ({ query: parent.topic, sources: '', summary: '' }),
 *     output: (sub, parent) => { parent.summary = sub.summary; },
 * });
 * ```
 *
 * @module runtime/graph/nodes
 */

import type {
    IGraphNode,
    IGraphEngine,
    GraphContext,
    GraphRunResult,
    GraphState,
} from '../../../contracts/graph/index.js';

/** Configuration for a sub-graph node. */
export interface SubGraphNodeConfig<
    TParent extends GraphState,
    TSub extends GraphState,
> {
    /** Unique node ID in the parent graph. Must be non-empty. */
    id: string;
    /** Pre-built engine for the sub-graph. */
    engine: IGraphEngine<TSub>;
    /** Map parent state → sub-graph initial state. Must be a pure function. */
    input: (parent: Readonly<TParent>) => TSub;
    /** Write sub-graph results back to parent state. */
    output: (subState: Readonly<TSub>, parent: TParent) => void;
}

export class SubGraphNode<
    TParent extends GraphState = GraphState,
    TSub extends GraphState = GraphState,
> implements IGraphNode<TParent>
{
    public readonly id: string;
    private readonly config: Readonly<SubGraphNodeConfig<TParent, TSub>>;

    /** After execution, holds the full sub-graph run result for inspection. */
    public lastRunResult?: GraphRunResult<TSub>;

    constructor(config: SubGraphNodeConfig<TParent, TSub>) {
        if (!config.id || config.id.trim().length === 0) {
            throw new Error('SubGraphNode: id must be a non-empty string.');
        }
        if (!config.engine || typeof config.engine.run !== 'function') {
            throw new Error('SubGraphNode: engine with a run() method is required.');
        }
        if (typeof config.input !== 'function') {
            throw new Error('SubGraphNode: input must be a function.');
        }
        if (typeof config.output !== 'function') {
            throw new Error('SubGraphNode: output must be a function.');
        }
        this.id = config.id;
        this.config = config;
    }

    async process(state: TParent, _context: GraphContext<TParent>): Promise<void> {
        const subInitial = this.config.input(state);
        const result = await this.config.engine.run(subInitial);
        this.lastRunResult = result;
        this.config.output(result.state, state);
    }
}
