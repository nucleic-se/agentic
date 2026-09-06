import { describe, expect, it } from 'vitest';
import { commitJournalTransition, type ExecutionJournal } from './ExecutionJournal.js';

describe('execution journal primitive', () => {
    it('uses a caller-provided CAS store without retrying stale transitions', async () => {
        let state = { revision: 0, outcomes: [] as string[] };
        const events: Array<{ sequence: number; result: string }> = [];
        let commits = 0;
        const journal: ExecutionJournal<typeof state, (typeof events)[number]> = {
            async get() { return structuredClone(state); },
            async commit(_id, expected, next, event) {
                commits++;
                if (expected !== state.revision) throw new Error('stale');
                state = structuredClone(next); events.push(structuredClone(event));
            },
        };
        const results = await Promise.allSettled(['one', 'two'].map(result => commitJournalTransition(journal, 'scope', {
            update(record) { record.outcomes.push(result); }, event: record => ({ sequence: record.revision, result }),
        })));
        expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
        expect(commits).toBe(2);
        expect(state).toEqual({ revision: 1, outcomes: ['one'] });
        expect(events).toEqual([{ sequence: 1, result: 'one' }]);
    });
});
