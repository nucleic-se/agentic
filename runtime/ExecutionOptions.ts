import type { ProviderCallOptions } from '../contracts/llm.js';

/** One cancellable deadline for a composed operation. Call dispose when it finishes. */
export function executionSignal(options: ProviderCallOptions = {}): { signal: AbortSignal; dispose(): void } {
    if (options.deadline !== undefined && !Number.isFinite(options.deadline)) {
        throw new RangeError('Deadline must be a finite timestamp');
    }
    const controller = new AbortController();
    let signal: AbortSignal;
    if (options.signal) {
        if (options.deadline === undefined) {
            signal = options.signal;
        } else {
            signal = AbortSignal.any([options.signal, controller.signal]);
        }
    } else {
        signal = controller.signal;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
        const remaining = options.deadline! - Date.now();
        if (remaining <= 0) {
            controller.abort(new DOMException('Execution deadline exceeded', 'TimeoutError'));
        } else {
            timer = setTimeout(schedule, Math.min(remaining, 2147483647));
        }
    };
    if (options.deadline !== undefined) {
        schedule();
    }
    return {
        signal,
        dispose() {
            if (timer) {
                clearTimeout(timer);
            }
        },
    };
}

export interface ExecutionLimits {
    maxModelCalls?: number;
    maxToolCalls?: number;
    maxToolCallsPerBatch?: number;
    timeoutMs?: number;
}
