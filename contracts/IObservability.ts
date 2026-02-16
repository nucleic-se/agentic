/**
 * Observability contracts (generic portion only).
 *
 * TraceEvent + ITracer: lightweight structured tracing.
 * Domain-specific event sinks (StructuredEvent, IEventSink) live
 * in their respective domain layers, not here.
 */

export interface TraceEvent {
    /** Grouping key — correlates related events (e.g. a graph run, a session). */
    correlationId: string;
    type: string;
    timestamp: number;
    data: Record<string, unknown>;
}

export interface ITracer {
    /** Emit a structured trace event. */
    trace(event: TraceEvent): void;

    /** Query recent trace events (most recent first). */
    recent(correlationId: string, limit: number): TraceEvent[];
}
