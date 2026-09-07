import { expect, it } from 'vitest';
import { validateOperationResolution } from './resolution.js';
import type { OperationResolution } from './types.js';

it('snapshots verified evidence and rejects unresolved or malformed outcomes', () => {
    const input = { expectedRevision: 3, evidence: 'Read the saved external record', result: { ok: true, content: 'Written' } };
    const snapshot = validateOperationResolution(input);
    input.result.content = 'Changed caller buffer';
    expect(snapshot.result.content).toBe('Written');
    for (const invalid of [
        { ...input, expectedRevision: -1 }, { ...input, expectedRevision: 1.5 },
        { ...input, evidence: ' ' }, { ...input, evidence: 'x'.repeat(16001) },
        ...['unknown', 'timeout', 'cancelled', 'invented'].map(errorKind => ({ ...input, result: { ok: false, content: 'Uncertain', errorKind } })),
    ]) expect(() => validateOperationResolution(invalid as OperationResolution)).toThrow();
});
