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
