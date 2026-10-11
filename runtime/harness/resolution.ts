import { randomUUID } from 'node:crypto';
import { toToolResultMessage } from '../ToolOutput.js';
import { commitJournalTransition } from '../ExecutionJournal.js';
import type { SessionRecord, SessionStore, OperationResolution } from './types.js';

/** Snapshot caller-supplied evidence before a host performs its revision-checked commit. */
export function validateOperationResolution(resolution: OperationResolution): OperationResolution {
    const input = structuredClone(resolution);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || typeof input.evidence !== 'string' || !input.evidence.trim() || input.evidence.length > 16000)
        throw new Error('Resolution requires a revision and bounded evidence');
    if (!input.result || typeof input.result.ok !== 'boolean' || typeof input.result.content !== 'string' || ![undefined, 'validation', 'policy', 'runtime'].includes(input.result.errorKind))
        throw new Error('Resolution requires a known tool result');
    return input;
}

/** Shared pure transition for running hosts and fenced offline operator recovery. */
export function applyOperationResolution(record: SessionRecord, operationId: string, resolution: OperationResolution): void {
    if (record.status === 'running' || record.status === 'waiting' || record.activeRunId)
        throw new Error('Finish the run before resolving an operation');
    if (record.revision !== resolution.expectedRevision) throw new Error('Session revision conflict');
    const op = record.operations.find(item => item.id === operationId);
    if (!op || op.kind !== 'tool' || op.status !== 'unknown') throw new Error('Operation is not an unresolved tool effect');
    const previous = op.output as import('../../contracts/agent.js').ToolExecution | undefined;
    const callId = op.callId ?? previous?.callId;
    if (!callId) throw new Error('Legacy operation lacks a tool call identity; preserve it for manual reconciliation');
    op.status = resolution.result.ok ? 'completed' : 'failed';
    op.resolution = structuredClone(resolution);
    const message = toToolResultMessage({ id: callId, name: op.name }, { ...resolution.result, content: resolution.result.content });
    let index = record.messages.length - 1;
    while (index >= 0) {
        const item = record.messages[index];
        if (item.role === 'tool_result' && item.toolCallId === callId) break;
        index--;
    }
    delete record.contextState;
    if (index >= 0) record.messages[index] = message;
    else record.messages.push(message);
    if (!record.operations.some(item => item.kind === 'tool' && item.status === 'unknown')) {
        record.status = 'interrupted';
        delete record.error;
    }

}

/** The caller must own the store and fence host admission before offline mutation. */
export async function resolveSessionOperation(store: Pick<SessionStore, 'get' | 'commit'>, id: string,
    operationId: string, resolution: OperationResolution): Promise<SessionRecord> {
    const input = validateOperationResolution(resolution);
    return commitJournalTransition(store, id, {
        update(record) { applyOperationResolution(record, operationId, input); record.updatedAt = Date.now(); },
        event: record => ({ schemaVersion: 1 as const, id: randomUUID(), sessionId: id, sequence: record.revision,
            timestamp: record.updatedAt, type: 'tool.resolved', data: { operationId, ...input } }),
    });
}

/** Safe operational metadata; excludes prompts, tool arguments, results and errors. */
export function inspectSessionRecovery(record: SessionRecord) {
    return {
        sessionId: record.id, revision: record.revision, status: record.status,
        active: Boolean(record.activeRunId) || record.status === 'running' || record.status === 'waiting',
        unresolvedToolCount: record.operations.filter(op => op.kind === 'tool' && ['intent','partial','unknown'].includes(op.status)).length,
        unfinishedInputCount: (record.inputReceipts ?? []).filter(r => ['accepted','running','interrupted'].includes(r.status)).length,
        queuedInputs: record.queue.length, pendingApprovals: record.approvals.length,
        unfinishedInputs: (record.inputReceipts ?? []).filter(r => r.status === 'accepted' || r.status === 'running' || r.status === 'interrupted').slice(0, 100).map(r => ({id:r.commandId.slice(0, 256),status:r.status})),
        unresolvedTools: record.operations.filter(op => op.kind === 'tool' && ['intent','partial','unknown'].includes(op.status)).slice(0, 100).map(op => ({
            id: op.id.slice(0, 256), name: op.name?.slice(0, 256), callId: op.callId?.slice(0, 256), status: op.status, resolvable: op.status === 'unknown' && Boolean(op.callId ?? (op.output as {callId?:string} | undefined)?.callId),
        })),
    };
}
