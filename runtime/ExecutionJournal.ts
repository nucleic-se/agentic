/** Minimal atomic execution-state boundary. Backends may be memory, SQL or an application store. */
export interface ExecutionJournal<State extends { revision: number }, Event extends { sequence: number }> {
    get(id: string): Promise<State | undefined>;
    /** Atomically commit state and its event, or reject without changing either on a stale revision. */
    commit(id: string, expectedRevision: number, state: State, event: Event): Promise<void>;
}

/** One optimistic transition. Callers choose serialization/retry policy; effects are never retried here. */
export async function commitJournalTransition<
    State extends { revision: number }, Event extends { sequence: number },
>(journal: ExecutionJournal<State, Event>, id: string, transition: {
    update(state: State): void;
    event(state: State): Event;
}): Promise<State> {
    const stored = await journal.get(id);
    if (!stored) throw new Error('Execution journal state not found');
    const state = structuredClone(stored), expectedRevision = state.revision;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid execution journal revision');
    transition.update(state);
    state.revision = expectedRevision + 1;
    const event = transition.event(state);
    if (event.sequence !== state.revision) throw new Error('Execution journal event sequence does not match state revision');
    await journal.commit(id, expectedRevision, structuredClone(state), structuredClone(event));
    return structuredClone(state);
}
