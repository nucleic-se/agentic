/**
 * In-memory tracer with ring buffer.
 */

import type { ITracer, TraceEvent } from '../contracts/index.js';

export class InMemoryTracer implements ITracer {
    private events: TraceEvent[] = [];
    private maxEvents: number;

    constructor(maxEvents = 10000) {
        this.maxEvents = maxEvents;
    }

    trace(event: TraceEvent): void {
        this.events.push(event);
        // Ring buffer: drop oldest when full
        if (this.events.length > this.maxEvents) {
            this.events.shift();
        }
    }

    recent(simulationId: string, limit: number): TraceEvent[] {
        return this.events
            .filter(e => e.simulationId === simulationId)
            .slice(-limit)
            .reverse();
    }
}
