/**
 * Tick pipeline runtime.
 *
 * Composable, no default steps. Steps execute in order, failing fast on error.
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

    listSteps(): ITickStep<TContext>[] {
        return Array.from(this.steps.values()).sort((a, b) => a.order - b.order);
    }

    async run(correlationId: string, context: TContext): Promise<void> {
        const ordered = this.listSteps();
        if (ordered.length === 0) {
            throw new Error(`No tick steps registered for simulation "${correlationId}". Pipeline cannot run empty.`);
        }

        for (const step of ordered) {
            await step.execute(context);
        }
    }
}
