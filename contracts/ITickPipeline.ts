/**
 * Tick pipeline contracts.
 *
 * Composable step-based pipeline for executing ordered steps.
 * Domain-agnostic: extend TickContext with domain-specific fields.
 *
 * Generic parameters allow domains to add typed fields to the context
 * (e.g. timeOfDay, weather) while keeping the library interface clean.
 */

export interface TickContext {
    correlationId: string;
    tick: number;
    /** Arbitrary per-step state bag for the current tick. Domain subtypes narrow this. */
    stepState: object;
}

export interface ITickStep<TContext extends TickContext = TickContext> {
    /** Unique identifier for this step */
    id: string;

    /** Execution order (lower runs first) */
    order: number;

    /** Execute this step. Returns void; mutates world state via services. */
    execute(context: TContext): Promise<void>;
}

export interface ITickPipeline<TContext extends TickContext = TickContext> {
    /** Register a tick step. Duplicate id replaces existing. */
    registerStep(step: ITickStep<TContext>): void;

    /** Resolve a step by id, or null if not found */
    resolveStep(id: string): ITickStep<TContext> | null;

    /** List all registered steps in execution order */
    listSteps(): ITickStep<TContext>[];

    /** Execute all steps in order for the given simulation tick */
    run(correlationId: string, context: TContext): Promise<void>;
}
