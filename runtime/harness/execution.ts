import { isDeepStrictEqual } from 'node:util';
import type { ILLMProvider, ProviderCallOptions, TurnRequest } from '../../contracts/llm.js';
import type { ContextReport } from '../../contracts/IAgentContextAssembler.js';
import { executeModelTurn, type ModelTurnOptions } from '../ModelExecutor.js';
import { executeToolBatchDetailed } from '../ToolBatchExecutor.js';
import { executionSignal } from '../ExecutionOptions.js';
import type { ContextStrategy } from './types.js';

export interface HarnessExecutionRoles {
    provider: ILLMProvider;
    context: ContextStrategy;
}
export interface HarnessDispatchOptions extends ModelTurnOptions {
    /** Awaited before intent/admission; observations cannot alter the selected request. */
    onPrepared?(report: ContextReport | undefined): void | Promise<void>;
}
export interface HarnessModelOptions extends HarnessPreparationOptions, HarnessDispatchOptions {}
/** An execution-owned preparation. Inspection returns copies; dispatch uses its original snapshot. */
export interface PreparedHarnessModel {
    readonly request: TurnRequest;
    readonly report?: ContextReport;
}
export interface HarnessPreparationOptions extends Pick<ProviderCallOptions, 'signal' | 'deadline'> {
    /** Per-request estimated context ceiling, including reserved output. Requires accounting. */
    contextTokenBudget?: number;
    /** Reject a context strategy that removes or rewrites any supplied source message. */
    preserveMessages?: boolean;
}

function validateReport(report: ContextReport | undefined, outputTokens: number) {
    if (!report) return;
    const parts = ['systemTokens', 'messageTokens', 'toolTokens', 'schemaTokens', 'reservedOutputTokens'] as const;
    if (
        !report.usage ||
        !Array.isArray(report.decisions) ||
        (report.tokenBudget !== undefined && (
            !Number.isSafeInteger(report.tokenBudget) ||
            report.tokenBudget < 1 ||
            report.usage.totalTokens > report.tokenBudget
        )) ||
        [...parts, 'totalTokens' as const].some(key => !Number.isSafeInteger(report.usage[key]) || report.usage[key] < 0) ||
        report.usage.totalTokens !== parts.reduce((total, key) => total + report.usage[key], 0) ||
        report.usage.reservedOutputTokens < outputTokens
    ) {
        throw new Error('Context strategy returned inconsistent token accounting');
    }
    const groups = report.decisions.filter(decision => decision.kind === 'messages');
    for (const group of groups) {
        if (group.tokens === undefined) continue;
        if (
            !group.tokens ||
            !Number.isSafeInteger(group.tokens.original) ||
            group.tokens.original < 0 ||
            !Number.isSafeInteger(group.tokens.retained) ||
            group.tokens.retained < 0 ||
            (group.action === 'dropped' && group.tokens.retained !== 0)
        ) {
            throw new Error('Context strategy returned inconsistent group token accounting');
        }
    }
    if (
        groups.length &&
        groups.every(group => group.tokens !== undefined) &&
        groups.reduce((sum, group) => sum + group.tokens!.retained, 0) !== report.usage.messageTokens
    ) {
        throw new Error('Context strategy returned inconsistent group token accounting');
    }
}

/** The same request boundary for interactive and durable drivers. No scheduling or storage. */
export function createHarnessExecution(roles: HarnessExecutionRoles) {
    const preparations = new WeakMap<PreparedHarnessModel, {
        request: TurnRequest;
        report?: ContextReport;
    }>();
    async function prepareModel(request: TurnRequest, options: HarnessPreparationOptions = {}): Promise<PreparedHarnessModel> {
        const { signal, dispose } = executionSignal(options);
        try {
            signal.throwIfAborted();
            const source = structuredClone(request);
            const ceiling = options.contextTokenBudget;
            if (ceiling !== undefined && (!Number.isSafeInteger(ceiling) || ceiling < 1)) {
                throw new RangeError('contextTokenBudget must be a positive safe integer');
            }
            if (source.maxTokens !== undefined && (!Number.isSafeInteger(source.maxTokens) || source.maxTokens < 1)) {
                throw new RangeError('maxTokens must be a positive safe integer');
            }
            const context = await roles.context.assemble(structuredClone(source.messages), signal, {
                tools: structuredClone(source.tools ?? []),
                ...(ceiling === undefined ? {} : { tokenBudget: ceiling }),
                ...(source.system === undefined ? {} : { system: source.system }),
                ...(source.maxTokens === undefined ? {} : { reservedOutputTokens: source.maxTokens }),
            });
            signal.throwIfAborted();
            if (
                !context ||
                !Array.isArray(context.messages) ||
                context.messages.some(message =>
                    !message ||
                    !['user', 'assistant', 'tool_result'].includes(message.role) ||
                    typeof message.content !== 'string'
                ) ||
                (context.system !== undefined && typeof context.system !== 'string')
            ) {
                throw new Error('Context strategy returned invalid context');
            }
            if (options.preserveMessages && !isDeepStrictEqual(source.messages, context.messages)) {
                throw new Error('Context strategy changed protected source messages');
            }
            validateReport(context.report, source.maxTokens ?? 0);
            if (ceiling !== undefined && (!context.report || context.report.usage.totalTokens > ceiling)) {
                throw new Error('Context strategy must report usage within the requested context token budget');
            }
            // An opaque provider continuation can retain history the local selector never counted.
            if (context.report && source.previousResponseId) {
                throw new Error('Budgeted context cannot account for opaque provider continuation history');
            }
            const snapshot = structuredClone({
                request: {
                    ...source,
                    system: context.system,
                    messages: context.messages,
                },
                report: context.report,
            });
            const prepared = Object.freeze({
                get request() {
                    return structuredClone(snapshot.request);
                },
                get report() {
                    return structuredClone(snapshot.report);
                },
            });
            preparations.set(prepared, snapshot);
            return prepared;
        } finally {
            dispose();
        }
    }
    async function dispatchModel(prepared: PreparedHarnessModel, options: HarnessDispatchOptions = {}) {
        const { signal, dispose } = executionSignal(options);
        try {
            signal.throwIfAborted();
            const original = preparations.get(prepared);
            if (!original) throw new Error('Prepared request belongs to a different execution or was not prepared');
            const snapshot = structuredClone(original);
            // Only prepareModel can create this private, already-validated snapshot.
            await options.onPrepared?.(structuredClone(snapshot.report));
            signal.throwIfAborted();
            return await executeModelTurn(roles.provider, snapshot.request, { ...options, signal });
        } finally {
            dispose();
        }
    }
    return {
        prepareModel,
        dispatchModel,
        async model(request: TurnRequest, options: HarnessModelOptions = {}) {
            const { signal, dispose } = executionSignal(options);
            try {
                const prepared = await prepareModel(request, { ...options, signal });
                return await dispatchModel(prepared, { ...options, signal });
            } finally {
                dispose();
            }
        },
        tools: executeToolBatchDetailed,
    };
}
export type HarnessExecution = ReturnType<typeof createHarnessExecution>;
