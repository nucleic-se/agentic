import type { Operation, SessionRecord, SessionEvent } from './types.js';
import type { TurnRequest } from '../../contracts/llm.js';
import type { ContextReport } from '../../contracts/IAgentContextAssembler.js';

/** A committed state and a bounded trace page, never a reconstructed model request. */
export interface HarnessSnapshot<State, Event> {
    capturedAt: number;
    revision: number;
    state: State;
    events: Event[];
    nextSequence: number;
}

/** Reading inspection data never invokes context selection, tools or the provider. */
export async function inspectHarness<State extends { revision: number }, Event extends { sequence: number }>(
    store: { get(id: string): Promise<State | undefined>; events(id: string, after: number, limit?: number): Promise<Event[]> },
    id: string, afterSequence = 0,
): Promise<HarnessSnapshot<State, Event>> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error('Invalid inspection cursor');
    const state = await store.get(id);
    if (!state) throw new Error('Inspection target not found');
    const capturedAt = Date.now();
    // Concurrent commits may arrive after the state read. Exclude them from this snapshot.
    const events = (await store.events(id, afterSequence, 200)).filter(event => event.sequence <= state.revision);
    return { capturedAt, revision: state.revision, state, events,
        nextSequence: events.at(-1)?.sequence ?? afterSequence };
}

/** Resolve one persisted model request without replaying assembly or loading the whole journal. */
export async function inspectOperation(
    store: { get(id: string): Promise<SessionRecord | undefined>; events(id: string, after: number, limit?: number): Promise<SessionEvent[]> },
    sessionId: string, operationId: string,
): Promise<{ operation: Operation; request?: TurnRequest; contextReport?: ContextReport }> {
    const state = await store.get(sessionId);
    const operation = state?.operations.find(item => item.id === operationId);
    if (!operation) throw new Error('Operation not found');
    if (operation.kind !== 'model') return { operation: structuredClone(operation) };
    const reference = operation.requestRef;
    if (!reference || !Number.isSafeInteger(reference.sequence) || reference.sequence < 1)
        throw new Error('Model operation has no valid request reference');
    const [event] = await store.events(reference.sessionId, reference.sequence - 1, 1);
    const data = event?.data as { operationId?: string; request?: TurnRequest; contextReport?: ContextReport } | undefined;
    if (event?.sessionId !== reference.sessionId || event.sequence !== reference.sequence ||
        event.type !== 'model.intent' || data?.operationId !== operationId || !data.request)
        throw new Error('Recorded model request is missing or mismatched');
    return structuredClone({ operation, request: data.request, contextReport: data.contextReport });
}
