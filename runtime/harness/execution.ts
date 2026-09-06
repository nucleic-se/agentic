import type { ILLMProvider, TurnRequest } from '../../contracts/llm.js';
import type { ContextReport } from '../../contracts/IAgentContextAssembler.js';
import { executeModelTurn, type ModelTurnOptions } from '../ModelExecutor.js';
import { executeToolBatchDetailed } from '../ToolBatchExecutor.js';
import { executionSignal } from '../ExecutionOptions.js';
import type { ContextStrategy } from './types.js';

export interface HarnessExecutionRoles { provider: ILLMProvider; context: ContextStrategy }
export interface HarnessModelOptions extends ModelTurnOptions {
    /** Awaited before intent/admission; observations cannot alter the selected request. */
    onPrepared?(report: ContextReport | undefined): void | Promise<void>;
}

function validateReport(report: ContextReport | undefined, outputTokens: number) {
    if (!report) return;
    const parts = ['systemTokens', 'messageTokens', 'toolTokens', 'schemaTokens', 'reservedOutputTokens'] as const;
    if (!report.usage || !Array.isArray(report.decisions) ||
        [...parts, 'totalTokens' as const].some(key => !Number.isSafeInteger(report.usage[key]) || report.usage[key] < 0) ||
        report.usage.totalTokens !== parts.reduce((total, key) => total + report.usage[key], 0) ||
        report.usage.reservedOutputTokens < outputTokens) throw new Error('Context strategy returned inconsistent token accounting');
}

/** The same request boundary for interactive and durable drivers. No scheduling or storage. */
export function createHarnessExecution(roles: HarnessExecutionRoles) {
    return {
        async model(request: TurnRequest, options: HarnessModelOptions = {}) {
            const { signal, dispose } = executionSignal(options);
            try {
                signal.throwIfAborted();
                const source = structuredClone(request);
                if (source.maxTokens !== undefined && (!Number.isSafeInteger(source.maxTokens) || source.maxTokens < 1)) throw new RangeError('maxTokens must be a positive safe integer');
                const context = await roles.context.assemble(structuredClone(source.messages), signal, {
                    tools: structuredClone(source.tools ?? []),
                    ...(source.system === undefined ? {} : { system: source.system }),
                    ...(source.maxTokens === undefined ? {} : { reservedOutputTokens: source.maxTokens }),
                });
                signal.throwIfAborted();
                if (!context || !Array.isArray(context.messages) ||
                    context.messages.some(message => !message || !['user', 'assistant', 'tool_result'].includes(message.role) || typeof message.content !== 'string') ||
                    (context.system !== undefined && typeof context.system !== 'string')) throw new Error('Context strategy returned invalid context');
                validateReport(context.report, source.maxTokens ?? 0);
                // An opaque provider continuation can retain history the local selector never counted.
                if (context.report && source.previousResponseId) throw new Error('Budgeted context cannot account for opaque provider continuation history');
                const prepared = structuredClone({ ...source, system: context.system, messages: context.messages });
                await options.onPrepared?.(structuredClone(context.report));
                signal.throwIfAborted();
                return await executeModelTurn(roles.provider, prepared, { ...options, signal });
            } finally { dispose(); }
        },
        tools: executeToolBatchDetailed,
    };
}
export type HarnessExecution = ReturnType<typeof createHarnessExecution>;
