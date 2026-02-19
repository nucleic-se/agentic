/**
 * Observability contracts (generic portion only).
 *
 * TraceEvent + ITracer: lightweight structured tracing.
 * TraceSpan + ISpanTracer: hierarchical span-based tracing.
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

// ── Span-Based Tracing ─────────────────────────────────────────

/** A hierarchical span with duration, status, and metadata. */
export interface TraceSpan {
    readonly spanId: string;
    /** Parent span ID. Undefined = root span. */
    readonly parentSpanId?: string;
    readonly correlationId: string;
    readonly type: string;
    readonly startTime: number;
    readonly endTime?: number;           // undefined = still open
    readonly status: 'ok' | 'error' | 'cancelled';
    readonly metadata: Record<string, unknown>;
    readonly error?: string;
}

/**
 * Extended tracer with hierarchical span support.
 * Backward-compatible — also implements ITracer for flat events.
 */
export interface ISpanTracer extends ITracer {
    /** Open a new span. Returns spanId. */
    startSpan(params: Omit<TraceSpan, 'spanId' | 'endTime' | 'status'>): string;

    /** Close an open span. */
    endSpan(spanId: string, status: TraceSpan['status'], error?: string): void;

    /** Query spans by correlationId. */
    spans(correlationId: string): TraceSpan[];

    /** Export all spans as a structured log (JSON array). */
    export(): TraceSpan[];
}
