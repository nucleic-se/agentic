import type { Message, TurnRequest, TurnResponse } from '../../contracts/llm.js';
import type { HarnessExecution, PreparedHarnessModel } from './execution.js';
import { checkpointView, prepareCheckpoint, prepareCheckpointRepair, checkpointFromResponse, rejectedCheckpoint,
    type WorkingCheckpoint, type RejectedCheckpoint } from './checkpoint.js';

/** The driver supplies preparation only: strategies cannot dispatch or acquire budgets. */
export type ContextPreparation = Pick<HarnessExecution, 'prepareModel'>;
export interface ContextLifecycleInput {
    request: TurnRequest;
    /** Strategy-owned, serializable derived state. Original history remains host-owned. */
    state?: unknown;
    /** Transient host facts, included in task context but never covered by a source checkpoint. */
    suffix?: Message[];
    /** Supplemental durable evidence. The strategy cannot mutate its host-owned source. */
    notes?: string;
}
export interface ContextTransition {
    state: unknown;
    /** Inspectable strategy decision, committed alongside the model receipt. */
    decision: unknown;
    /** Persist the transition and receipt before stopping the task. */
    error?: string;
}
export interface ContextMaintenance {
    kind: 'maintenance';
    prepared: PreparedHarnessModel;
    metadata: Record<string, unknown>;
    /** Pure reduction of a complete response. No storage, provider or host mutation. */
    reduce(response: TurnResponse): ContextTransition;
}
export type ContextStep = {
    kind: 'task';
    prepared: PreparedHarnessModel;
    metadata?: Record<string, unknown>;
    /** Optional state update committed with the ordinary task response, without a maintenance call. */
    reduce?(response: TurnResponse): ContextTransition;
} | ContextMaintenance;
export interface ContextLifecycle {
    prepare(input: ContextLifecycleInput, execution: ContextPreparation): Promise<ContextStep>;
}

/** Use the selected context assembler directly, without generated memory or maintenance calls. */
export function referenceContextLifecycle(): ContextLifecycle {
    return { async prepare({ request, suffix = [] }, execution) {
        return { kind: 'task', prepared: await execution.prepareModel({ ...request, messages: [...request.messages, ...suffix] }) };
    } };
}

export interface CheckpointContextState {
    kind: 'checkpoint';
    checkpoint?: WorkingCheckpoint;
    rejected?: RejectedCheckpoint;
}
function checkpointState(value: unknown): CheckpointContextState {
    if (value === undefined) return { kind: 'checkpoint' };
    if (!value || typeof value !== 'object' || (value as CheckpointContextState).kind !== 'checkpoint')
        throw new Error('Context state does not belong to the checkpoint strategy');
    return structuredClone(value as CheckpointContextState);
}

/** Checkpoint selection and repair are one replaceable policy; hosts persist its opaque state. */
export function checkpointContextLifecycle(configuration: { maxTokens: number; triggerRatio?: number }): ContextLifecycle {
    const config = { ...configuration };
    if (!Number.isSafeInteger(config.maxTokens) || config.maxTokens < 1) throw new RangeError('Checkpoint output budget must be a positive safe integer');
    if (config.triggerRatio !== undefined && (!Number.isFinite(config.triggerRatio) || config.triggerRatio <= 0 || config.triggerRatio > 1))
        throw new RangeError('Checkpoint triggerRatio must be greater than zero and no greater than one');
    return { async prepare(input, execution) {
        const { request, suffix = [], notes } = input;
        const state = checkpointState(input.state);
        const cacheScope = request.cacheScope === undefined ? undefined : `${request.cacheScope}:checkpoint`;
        // A rejected candidate already identifies its exact source. Repair does not depend on fitting the task again.
        let selected = state.rejected ? await prepareCheckpointRepair(execution, request.messages, state.rejected, {
            maxTokens: config.maxTokens, cacheScope: cacheScope === undefined ? undefined : `${cacheScope}:repair`,
        }) : undefined;
        if (!selected) {
            const view = checkpointView(request.messages, state.checkpoint, suffix);
            const prepared = await execution.prepareModel({ ...request, messages: view.messages });
            if (!prepared.report) throw new Error('Checkpoint strategy requires a context usage report');
            selected = await prepareCheckpoint(execution, request.messages, view, prepared.report, {
                ...config, previous: state.checkpoint, notes, cacheScope,
            });
            if (!selected) return { kind: 'task', prepared };
        }
        const selection = selected;
        return { kind: 'maintenance', prepared: selection.prepared,
            metadata: { purpose: 'checkpoint', sourceRange: selection.sourceRange },
            reduce(response) {
                const draft = checkpointFromResponse(selection, response);
                if (draft.ok) return { state: { kind: 'checkpoint', checkpoint: draft.checkpoint }, decision: { accepted: true } };
                const attempt = state.rejected ? 2 : 1;
                return { state: { ...state, rejected: rejectedCheckpoint(selection, response, draft.reason) },
                    decision: { accepted: false, reason: draft.reason, attempt },
                    ...(attempt === 2 ? { error: `Checkpoint rejected after two attempts: ${draft.reason}` } : {}) };
            },
        };
    } };
}
