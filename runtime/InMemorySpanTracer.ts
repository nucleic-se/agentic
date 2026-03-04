/**
 * In-memory span tracer with hierarchical span support.
 *
 * Extends InMemoryTracer (inheriting ring-buffered trace() / recent())
 * with span lifecycle management: open spans are tracked in-flight and
 * finalised via endSpan().
 *
 * @module runtime
 */

import type { ISpanTracer, TraceSpan } from '../contracts/IObservability.js';
import { InMemoryTracer } from './InMemoryTracer.js';
import { randomUUID } from 'node:crypto';

export class InMemorySpanTracer extends InMemoryTracer implements ISpanTracer {
    private readonly spanStore: TraceSpan[] = [];
    private readonly openSpans = new Map<string, TraceSpan>();

    // ── ISpanTracer ────────────────────────────────────────────

    startSpan(params: Omit<TraceSpan, 'spanId' | 'endTime' | 'status'>): string {
        const spanId = randomUUID();
        const span: TraceSpan = {
            ...params,
            spanId,
            status: 'ok', // default until ended
            endTime: undefined,
        };
        this.openSpans.set(spanId, span);
        return spanId;
    }

    endSpan(spanId: string, status: TraceSpan['status'], error?: string): void {
        const span = this.openSpans.get(spanId);
        if (!span) return;

        const finalized: TraceSpan = {
            ...span,
            endTime: Date.now(),
            status,
            error,
        };

        this.openSpans.delete(spanId);
        this.spanStore.push(finalized);

        // Also emit as a flat trace event for backward compatibility.
        this.trace({
            correlationId: finalized.correlationId,
            type: `span.${finalized.type}`,
            timestamp: finalized.endTime!,
            data: {
                spanId: finalized.spanId,
                parentSpanId: finalized.parentSpanId,
                status: finalized.status,
                durationMs: finalized.endTime! - finalized.startTime,
                error: finalized.error,
                ...finalized.metadata,
            },
        });
    }

    spans(correlationId: string): TraceSpan[] {
        return this.spanStore.filter(s => s.correlationId === correlationId);
    }

    export(): TraceSpan[] {
        return [...this.spanStore];
    }
}
