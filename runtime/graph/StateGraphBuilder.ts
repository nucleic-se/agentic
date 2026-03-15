/**
 * Fluent builder for constructing a state graph and its engine.
 *
 * Validates the graph on build() — catches structural errors early
 * rather than at runtime.
 *
 * Usage:
 * ```ts
 * const engine = new StateGraphBuilder<MyState>()
 *     .addNode(planNode)
 *     .addNode(researchNode)
 *     .setEntry('plan')
 *     .addEdge('plan', 'research')
 *     .addConditionalEdge('research', s => s.done ? END : 'plan')
 *     .build({ maxSteps: 50 });
 *
 * const result = await engine.run({ topic: 'quantum computing' });
 * ```
 *
 * @module runtime/graph
 */

import type {
    IGraphBuilder,
    IGraphNode,
    IGraphEngine,
    RouterFn,
    AsyncRouterFn,
    ParallelMergeFn,
    GraphEnd,
    GraphEngineConfig,
    GraphState,
} from '../../contracts/graph/index.js';
import { StateGraph } from './StateGraph.js';
import { StateGraphEngine } from './StateGraphEngine.js';

export class StateGraphBuilder<TState extends GraphState = GraphState>
    implements IGraphBuilder<TState>
{
    private readonly graph = new StateGraph<TState>();
    private built = false;

    addNode(node: IGraphNode<TState>): StateGraphBuilder<TState> {
        this.assertNotBuilt();
        this.graph.addNode(node);
        return this;
    }

    addEdge(from: string, to: string | GraphEnd): StateGraphBuilder<TState> {
        this.assertNotBuilt();
        this.graph.addEdge(from, to);
        return this;
    }

    addConditionalEdge(from: string, router: RouterFn<TState> | AsyncRouterFn<TState>): StateGraphBuilder<TState> {
        this.assertNotBuilt();
        this.graph.addConditionalEdge(from, router);
        return this;
    }

    addParallelEdge(
        from: string,
        targets: string[],
        merge: ParallelMergeFn<TState>,
        then: string | GraphEnd,
    ): StateGraphBuilder<TState> {
        this.assertNotBuilt();
        this.graph.addParallelEdge(from, targets, merge, then);
        return this;
    }

    setEntry(nodeId: string): StateGraphBuilder<TState> {
        this.assertNotBuilt();
        this.graph.setEntry(nodeId);
        return this;
    }

    /**
     * Build and return an engine for executing the graph.
     *
     * Validates the graph structure; throws if:
     * - No entry node is set.
     * - Any edge target references a non-existent node.
     *
     * Pass `allowCycles: true` to document that the graph intentionally
     * contains back-edges (e.g. a replan loop). The validator handles
     * cycles correctly regardless; this flag is advisory documentation.
     *
     * The builder is consumed — further mutations throw.
     */
    build(config?: GraphEngineConfig & { allowCycles?: boolean }): IGraphEngine<TState> {
        this.assertNotBuilt();

        const errors = this.graph.validate({ allowCycles: config?.allowCycles });
        if (errors.length > 0) {
            throw new Error(`Graph validation failed:\n  - ${errors.join('\n  - ')}`);
        }

        this.built = true;
        return new StateGraphEngine<TState>(this.graph, config);
    }

    // ── Private ────────────────────────────────────────────────

    private assertNotBuilt(): void {
        if (this.built) {
            throw new Error(
                'StateGraphBuilder: This builder has already been built. ' +
                'Create a new builder for a new graph.',
            );
        }
    }
}
