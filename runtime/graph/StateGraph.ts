/**
 * State graph — the topology (nodes + edges).
 *
 * Holds the structural definition of a graph. Does not execute.
 *
 * Invariants enforced:
 * - Node IDs must be non-empty, trimmed strings.
 * - Node IDs must be unique within the graph.
 * - Each node has at most one outbound edge (static or conditional).
 * - Edge source/target nodes must exist (except END target).
 * - Entry node must exist.
 *
 * @module runtime/graph
 */

import type {
    IGraph,
    IGraphNode,
    RouterFn,
    AsyncRouterFn,
    ParallelMergeFn,
    ParallelEdge,
    GraphEnd,
    GraphState,
} from '../../contracts/graph/index.js';
import { END } from '../../contracts/graph/index.js';

export class StateGraph<TState extends GraphState = GraphState>
    implements IGraph<TState>
{
    private readonly nodes = new Map<string, IGraphNode<TState>>();
    private readonly staticEdges = new Map<string, string | GraphEnd>();
    private readonly conditionalEdges = new Map<string, RouterFn<TState> | AsyncRouterFn<TState>>();
    private readonly parallelEdges = new Map<string, ParallelEdge<TState>>();
    private entryNodeId?: string;

    // ── Mutation API ───────────────────────────────────────────

    addNode(node: IGraphNode<TState>): void {
        this.validateNodeId(node.id, 'addNode');
        if (this.nodes.has(node.id)) {
            throw new Error(`addNode: Node '${node.id}' already exists.`);
        }
        this.nodes.set(node.id, node);
    }

    addEdge(from: string, to: string | GraphEnd): void {
        this.validateNodeId(from, 'addEdge (from)');
        this.assertNodeExists(from, 'addEdge');
        if (to !== END) {
            this.validateNodeId(to, 'addEdge (to)');
            this.assertNodeExists(to, 'addEdge');
        }
        this.assertNoExistingEdge(from);
        this.staticEdges.set(from, to);
    }

    addConditionalEdge(from: string, router: RouterFn<TState> | AsyncRouterFn<TState>): void {
        this.validateNodeId(from, 'addConditionalEdge');
        this.assertNodeExists(from, 'addConditionalEdge');
        if (typeof router !== 'function') {
            throw new Error('addConditionalEdge: Router must be a function.');
        }
        this.assertNoExistingEdge(from);
        this.conditionalEdges.set(from, router);
    }

    setEntry(nodeId: string): void {
        this.validateNodeId(nodeId, 'setEntry');
        this.assertNodeExists(nodeId, 'setEntry');
        this.entryNodeId = nodeId;
    }

    addParallelEdge(
        from: string,
        targets: string[],
        merge: ParallelMergeFn<TState>,
        then: string | GraphEnd,
    ): void {
        this.validateNodeId(from, 'addParallelEdge');
        this.assertNodeExists(from, 'addParallelEdge');
        if (!Array.isArray(targets) || targets.length < 2) {
            throw new Error('addParallelEdge: targets must contain at least 2 nodes.');
        }
        for (const t of targets) {
            this.validateNodeId(t, 'addParallelEdge (target)');
            this.assertNodeExists(t, 'addParallelEdge (target)');
        }
        if (typeof merge !== 'function') {
            throw new Error('addParallelEdge: merge must be a function.');
        }
        if (then !== END) {
            this.validateNodeId(then, 'addParallelEdge (then)');
            this.assertNodeExists(then, 'addParallelEdge (then)');
        }
        this.assertNoExistingEdge(from);
        this.parallelEdges.set(from, { targets, merge, then });
    }

    // ── Query API ──────────────────────────────────────────────

    getNode(id: string): IGraphNode<TState> | undefined {
        return this.nodes.get(id);
    }

    getStaticEdge(from: string): string | GraphEnd | undefined {
        return this.staticEdges.get(from);
    }

    getConditionalEdge(from: string): RouterFn<TState> | AsyncRouterFn<TState> | undefined {
        return this.conditionalEdges.get(from);
    }

    getParallelEdge(from: string): ParallelEdge<TState> | undefined {
        return this.parallelEdges.get(from);
    }

    getEntryNodeId(): string | undefined {
        return this.entryNodeId;
    }

    getNodes(): IGraphNode<TState>[] {
        return Array.from(this.nodes.values());
    }

    // ── Validation ─────────────────────────────────────────────

    /**
     * Validate the graph structure. Returns human-readable error
     * strings. An empty array means the graph is valid and ready
     * to execute.
     *
     * Checks:
     * - Entry node is set and exists.
     * - All static edge targets exist (or are END).
     * - No orphan nodes (unreachable from entry).
     *
     * Pass `{ allowCycles: true }` to document that back-edges are
     * intentional. The BFS reachability check already handles cycles
     * correctly (it never marks a node unreachable merely because it
     * is the target of a back-edge), so this flag is advisory only.
     */
    validate(options?: { allowCycles?: boolean }): string[] {
        void options; // advisory only — no behaviour change
        const errors: string[] = [];

        // Entry check
        if (!this.entryNodeId) {
            errors.push('No entry node set.');
        } else if (!this.nodes.has(this.entryNodeId)) {
            errors.push(`Entry node '${this.entryNodeId}' does not exist.`);
        }

        // Static edge target validity
        for (const [from, to] of this.staticEdges) {
            if (to !== END && !this.nodes.has(to)) {
                errors.push(`Edge from '${from}' targets non-existent node '${to}'.`);
            }
        }

        // Reachability (only if entry is valid)
        if (this.entryNodeId && this.nodes.has(this.entryNodeId)) {
            const reachable = this.computeReachable(this.entryNodeId);
            for (const node of this.nodes.values()) {
                if (!reachable.has(node.id)) {
                    errors.push(`Node '${node.id}' is unreachable from entry '${this.entryNodeId}'.`);
                }
            }
        }

        return errors;
    }

    // ── Private helpers ────────────────────────────────────────

    private validateNodeId(id: string, caller: string): void {
        if (typeof id !== 'string' || id.trim().length === 0) {
            throw new Error(`${caller}: Node ID must be a non-empty string.`);
        }
    }

    private assertNodeExists(id: string, caller: string): void {
        if (!this.nodes.has(id)) {
            throw new Error(`${caller}: Node '${id}' does not exist.`);
        }
    }

    private assertNoExistingEdge(from: string): void {
        if (this.staticEdges.has(from) || this.conditionalEdges.has(from) || this.parallelEdges.has(from)) {
            throw new Error(`Node '${from}' already has an outbound edge. Each node may have at most one.`);
        }
    }

    /**
     * BFS from the entry node, following static edges and treating
     * conditional edges as potentially reaching any node.
     * Returns the set of reachable node IDs.
     */
    private computeReachable(entryId: string): Set<string> {
        const visited = new Set<string>();
        const queue = [entryId];

        while (queue.length > 0) {
            const current = queue.shift()!;
            if (visited.has(current)) continue;
            visited.add(current);

            // Static edge
            const staticTarget = this.staticEdges.get(current);
            if (staticTarget && staticTarget !== END && !visited.has(staticTarget)) {
                queue.push(staticTarget);
            }

            // Conditional edges can potentially reach any node, but we
            // can't know which without running. Mark as reaching all
            // nodes that are targets in the graph for conservative analysis.
            // For now, treat conditional edges as reaching all nodes.
            if (this.conditionalEdges.has(current)) {
                for (const nodeId of this.nodes.keys()) {
                    if (!visited.has(nodeId)) {
                        queue.push(nodeId);
                    }
                }
            }

            // Parallel edge targets and then-node
            const parallel = this.parallelEdges.get(current);
            if (parallel) {
                for (const t of parallel.targets) {
                    if (!visited.has(t)) {
                        queue.push(t);
                    }
                }
                if (parallel.then !== END && !visited.has(parallel.then)) {
                    queue.push(parallel.then);
                }
            }
        }

        return visited;
    }
}
