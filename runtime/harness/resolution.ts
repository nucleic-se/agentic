import type { OperationResolution } from './types.js';

/** Snapshot caller-supplied evidence before a host performs its revision-checked commit. */
export function validateOperationResolution(resolution: OperationResolution): OperationResolution {
    const input = structuredClone(resolution);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || typeof input.evidence !== 'string' || !input.evidence.trim() || input.evidence.length > 16000)
        throw new Error('Resolution requires a revision and bounded evidence');
    if (!input.result || typeof input.result.ok !== 'boolean' || typeof input.result.content !== 'string' || ![undefined, 'validation', 'policy', 'runtime'].includes(input.result.errorKind))
        throw new Error('Resolution requires a known tool result');
    return input;
}
