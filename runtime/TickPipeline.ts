/**
 * Tick pipeline runtime.
 *
 * Composable, no default steps. Steps execute in topological order derived
 * from their `after` constraints. Steps with no constraints run in
 * registration order (stable tiebreak within the same topological level).
 *
 * Cycle detection and forward-reference resolution happen at run() time,
 * not at registerStep() time. This allows cross-module registration where
 * registration order is not coordinated.
 *
 * Generic over TContext so domains can extend TickContext with typed fields.
 */

import type { ITickPipeline, ITickStep, TickContext } from '../contracts/index.js';

export class TickPipeline<TContext extends TickContext = TickContext>
    implements ITickPipeline<TContext> {
    private steps = new Map<string, ITickStep<TContext>>();

    registerStep(step: ITickStep<TContext>): void {
        this.steps.set(step.id, step);
    }

    resolveStep(id: string): ITickStep<TContext> | null {
        return this.steps.get(id) ?? null;
    }

    /** Returns steps in registration order (Map insertion order). */
    listSteps(): ITickStep<TContext>[] {
        return Array.from(this.steps.values());
    }

    async run(correlationId: string, context: TContext): Promise<void> {
        const all = Array.from(this.steps.values());

        if (all.length === 0) {
            throw new Error(`No tick steps registered for simulation "${correlationId}". Pipeline cannot run empty.`);
        }

        const ordered = topoSort(all);

        for (const step of ordered) {
            await step.execute(context);
        }
    }
}

/**
 * Topological sort using Kahn's algorithm.
 * Registration order is the stable tiebreak within the same level.
 */
function topoSort<TContext extends TickContext>(steps: ITickStep<TContext>[]): ITickStep<TContext>[] {
    const ids = new Set(steps.map(s => s.id));
    const indexMap = new Map<string, number>(steps.map((s, i) => [s.id, i]));

    // Validate: all `after` references must point to known step IDs
    for (const step of steps) {
        for (const dep of step.after ?? []) {
            if (!ids.has(dep)) {
                throw new Error(`TickPipeline: unknown step id in after: ${dep}`);
            }
        }
    }

    // Build in-degree and adjacency (dep -> dependents)
    const inDegree = new Map<string, number>(steps.map(s => [s.id, 0]));
    const dependents = new Map<string, string[]>(steps.map(s => [s.id, []]));

    for (const step of steps) {
        for (const dep of step.after ?? []) {
            inDegree.set(step.id, inDegree.get(step.id)! + 1);
            dependents.get(dep)!.push(step.id);
        }
    }

    // Kahn's algorithm — stable sort by registration index within each level
    const queue: string[] = steps
        .filter(s => inDegree.get(s.id) === 0)
        .map(s => s.id)
        .sort((a, b) => indexMap.get(a)! - indexMap.get(b)!);

    const result: ITickStep<TContext>[] = [];

    while (queue.length > 0) {
        const id = queue.shift()!;
        const step = steps.find(s => s.id === id)!;
        result.push(step);

        const next = (dependents.get(id) ?? [])
            .filter(depId => {
                const newDeg = inDegree.get(depId)! - 1;
                inDegree.set(depId, newDeg);
                return newDeg === 0;
            })
            .sort((a, b) => indexMap.get(a)! - indexMap.get(b)!);

        queue.push(...next);
        // Re-sort queue to maintain stable registration-order tiebreak
        queue.sort((a, b) => indexMap.get(a)! - indexMap.get(b)!);
    }

    if (result.length !== steps.length) {
        const resolved = new Set(result.map(s => s.id));
        const cycled = steps.filter(s => !resolved.has(s.id)).map(s => s.id);
        throw new Error(`TickPipeline: cycle detected involving: ${cycled.join(', ')}`);
    }

    return result;
}
