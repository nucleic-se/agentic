/**
 * Callback graph node — wraps a plain function as a graph node.
 *
 * The callback receives the shared state and context, mutating state
 * directly. Ideal for lightweight logic, transforms, and adapter code
 * without needing a full class.
 *
 * ```ts
 * const increment = new CallbackGraphNode<MyState>('inc', async (state) => {
 *     state.counter++;
 * });
 * ```
 *
 * @module runtime/graph/nodes
 */

import type { IGraphNode, GraphContext, GraphState } from '../../../contracts/graph/index.js';

export class CallbackGraphNode<TState extends GraphState = GraphState>
    implements IGraphNode<TState>
{
    public readonly id: string;
    private readonly callback: (state: TState, context: GraphContext<TState>) => Promise<void> | void;

    constructor(
        id: string,
        callback: (state: TState, context: GraphContext<TState>) => Promise<void> | void,
    ) {
        if (!id || id.trim().length === 0) {
            throw new Error('CallbackGraphNode: id must be a non-empty string.');
        }
        if (typeof callback !== 'function') {
            throw new Error('CallbackGraphNode: callback must be a function.');
        }
        this.id = id;
        this.callback = callback;
    }

    async process(state: TState, context: GraphContext<TState>): Promise<void> {
        await this.callback(state, context);
    }
}
