/**
 * Observability contracts (generic portion only).
 *
 * TraceEvent + ITracer: lightweight structured tracing.
 * Domain-specific event sinks (StructuredEvent, IEventSink) live
 * in their respective domain layers, not here.
 */

export interface TraceEvent {
    simulationId: string;
    type: string;
    tick?: number;
    timestamp: number;
    data: Record<string, unknown>;
}

export interface ITracer {
    /** Emit a structured trace event */
    trace(event: TraceEvent): void;

    /** Query recent trace events (most recent first) */
    recent(simulationId: string, limit: number): TraceEvent[];
}
