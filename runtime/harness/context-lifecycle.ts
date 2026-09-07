import { ContextBudgetExceededError } from '../PromptEngine.js';
import type { Message, TurnRequest, TurnResponse } from '../../contracts/llm.js';
import type { HarnessExecution, PreparedHarnessModel } from './execution.js';
import { checkpointView, prepareCheckpoint, prepareCheckpointRepair, checkpointFromResponse, rejectedCheckpoint,
    type WorkingCheckpoint, type RejectedCheckpoint, type CheckpointSourceRange, type CheckpointEvidencePresentation } from './checkpoint.js';

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
    rejected?: RejectedCheckpoint & { attempt: 1 | 2 };
    /** A complete response awaiting local context admission. The last accepted checkpoint stays intact. */
    candidate?: WorkingCheckpoint & { sourceRange: CheckpointSourceRange; attempt: 1 | 2 };
}
function checkpointState(value: unknown): CheckpointContextState {
    if (value === undefined) return { kind: 'checkpoint' };
    if (!value || typeof value !== 'object' || (value as CheckpointContextState).kind !== 'checkpoint')
        throw new Error('Context state does not belong to the checkpoint strategy');
    return structuredClone(value as CheckpointContextState);
}

/** Checkpoint selection and repair are one replaceable policy; hosts persist its opaque state. */
export function checkpointContextLifecycle(configuration: { maxTokens: number; triggerRatio?: number; presentation?: CheckpointEvidencePresentation }): ContextLifecycle {
    const config = { ...configuration, ...(configuration.presentation ? { presentation: { ...configuration.presentation } } : {}) };
    if (!Number.isSafeInteger(config.maxTokens) || config.maxTokens < 1) throw new RangeError('Checkpoint output budget must be a positive safe integer');
    if (config.triggerRatio !== undefined && (!Number.isFinite(config.triggerRatio) || config.triggerRatio <= 0 || config.triggerRatio > 1))
        throw new RangeError('Checkpoint triggerRatio must be greater than zero and no greater than one');
    return { async prepare(input, execution) {
        const { request, suffix = [], notes } = input;
        let state = checkpointState(input.state);
        const cacheScope = request.cacheScope === undefined ? undefined : `${request.cacheScope}:checkpoint`;
        let prepared: PreparedHarnessModel | undefined;
        let validated: CheckpointSourceRange | undefined;
        if (state.candidate) {
            const { sourceRange, attempt, ...checkpoint } = state.candidate;
            try {
                prepared = await execution.prepareModel({ ...request, messages: checkpointView(request.messages, checkpoint, suffix).messages });
                validated = sourceRange;
                state = { kind: 'checkpoint', checkpoint };
            } catch (error) {
                if (!(error instanceof ContextBudgetExceededError)) throw error;
                if (attempt === 2) throw new Error('Checkpoint rejected after two attempts: too_large', { cause: error });
                state = { kind: 'checkpoint', checkpoint: state.checkpoint,
                    rejected: { ...checkpoint, sourceRange, reason: 'too_large', attempt } };
            }
        }
        if (state.rejected?.attempt === 2) throw new Error(`Checkpoint rejected after two attempts: ${state.rejected.reason}`);
        // Invalid responses and candidates that cannot fit share the same one-repair allowance.
        let selected = state.rejected ? await prepareCheckpointRepair(execution, request.messages, state.rejected, {
            maxTokens: config.maxTokens, cacheScope: cacheScope === undefined ? undefined : `${cacheScope}:repair`,
        }) : undefined;
        if (!selected) {
            const view = checkpointView(request.messages, state.checkpoint, suffix);
            prepared ??= await execution.prepareModel({ ...request, messages: view.messages });
            if (!prepared.report) throw new Error('Checkpoint strategy requires a context usage report');
            selected = await prepareCheckpoint(execution, request.messages, view, prepared.report, {
                ...config, previous: state.checkpoint, notes, cacheScope, tools: request.tools,
            });
            if (!selected) return { kind: 'task', prepared,
                ...(validated ? { metadata: { checkpointAccepted: validated },
                    reduce: () => ({ state, decision: { accepted: true } }) } : {}) };
        }
        const selection = selected;
        return { kind: 'maintenance', prepared: selection.prepared,
            metadata: { purpose: 'checkpoint', sourceRange: selection.sourceRange,
                ...(validated ? { checkpointAccepted: validated } : {}),
                ...(state.rejected ? { rejection: state.rejected.reason } : {}) },
            reduce(response) {
                const draft = checkpointFromResponse(selection, response);
                const attempt = state.rejected ? 2 : 1;
                if (draft.ok) return { state: { kind: 'checkpoint', checkpoint: state.checkpoint,
                    candidate: { ...draft.checkpoint, sourceRange: structuredClone(selection.sourceRange), attempt } },
                    decision: { pending: true, attempt } };
                return { state: { ...state, rejected: { ...rejectedCheckpoint(selection, response, draft.reason), attempt } },
                    decision: { accepted: false, reason: draft.reason, attempt },
                    ...(attempt === 2 ? { error: `Checkpoint rejected after two attempts: ${draft.reason}` } : {}) };
            },
        };
    } };
}
