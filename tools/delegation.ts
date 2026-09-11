import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { ILLMProvider, TokenUsage, ToolDefinition } from '../contracts/llm.js';
import type { IValidatedToolRuntime, ToolCallOptions, ToolCallResult } from '../contracts/tool-runtime.js';
import { createHarness } from '../runtime/harness/host.js';
import { MemorySessionStore } from '../runtime/harness/stores.js';
import { budgetedContext } from '../runtime/harness/context.js';
import { conversationalLoop } from '../runtime/harness/loops.js';
import type { SessionClient, SessionRecord } from '../runtime/harness/types.js';

export interface DelegationWorker {
    description: string;
    system: string;
    /** Borrowed provider; settings are selected by the application, never the model. */
    provider: ILLMProvider;
    /** Fresh owned runtime per child. Only explicitly read-declared tools are accepted. */
    tools?: (signal: AbortSignal) => IValidatedToolRuntime | Promise<IValidatedToolRuntime>;
}
export interface DelegationOptions {
    workers: Record<string, DelegationWorker>;
    /** Finite allowance across this runtime's lifetime; excludes parent calls and provider retries. */
    maxModelCalls: number;
    maxConcurrent?: number;
    maxTasks?: number;
    workerModelCalls?: number;
    workerToolCalls?: number;
    timeoutMs?: number;
    contextTokens?: number;
    outputTokens?: number;
    resultChars?: number;
    /** Application evidence sink, awaited before the child session is disposed. */
    onResult?: (record: SessionRecord, origin: { parentSessionId?: string; callId?: string; worker: string }) => void | Promise<void>;
}
export interface DelegationResult {
    worker: string;
    sessionId?: string;
    status: 'completed' | 'failed' | 'cancelled';
    answer: string;
    truncated: boolean;
    usage?: TokenUsage;
    /** True only when every admitted call has a validated completed/partial response receipt. */
    usageComplete: boolean;
    modelCalls: number;
    toolCalls: number;
    elapsedMs: number;
    error?: string;
}

const emptyTools = (): IValidatedToolRuntime => ({
    tools: () => [],
    validate: () => ({ ok: false, result: { ok: false, content: 'No worker tools enabled', errorKind: 'policy' } }),
    call: async () => ({ ok: false, content: 'No worker tools enabled', errorKind: 'policy' }),
});
function positive(value: number, name: string) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
    return value;
}

/** Flat, awaited read-only delegation. No background work, inherited permissions or nested agents. */
export function delegationToolRuntime(options: DelegationOptions): IValidatedToolRuntime {
    const workers = new Map(Object.entries(options.workers).map(([name, worker]) => {
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || !worker.description.trim()) throw new Error('Invalid worker name or description');
        return [name, { ...worker }] as const;
    }));
    if (!workers.size) throw new Error('At least one worker is required');
    const maxCalls = positive(options.maxModelCalls, 'maxModelCalls');
    const concurrent = positive(options.maxConcurrent ?? 2, 'maxConcurrent');
    const maxTasks = positive(options.maxTasks ?? concurrent, 'maxTasks');
    const workerCalls = positive(options.workerModelCalls ?? 10, 'workerModelCalls');
    const toolCalls = positive(options.workerToolCalls ?? 30, 'workerToolCalls');
    const timeoutMs = positive(options.timeoutMs ?? 120000, 'timeoutMs');
    if (timeoutMs > 2147483647) throw new RangeError('timeoutMs exceeds timer capacity');
    const contextTokens = positive(options.contextTokens ?? 32000, 'contextTokens');
    const outputTokens = positive(options.outputTokens ?? 2048, 'outputTokens');
    if (outputTokens >= contextTokens) throw new RangeError('outputTokens must be smaller than contextTokens');
    const resultChars = positive(options.resultChars ?? 6000, 'resultChars');
    const onResult = options.onResult;
    const schema = z.object({ tasks: z.array(z.object({
        worker: z.enum([...workers.keys()] as [string, ...string[]]),
        prompt: z.string().trim().min(1).max(32000),
    }).strict()).min(1).max(maxTasks) }).strict();
    let usedCalls = 0, active = 0, closed = false;
    let closing: Promise<void> | undefined;
    const shutdown = new AbortController();
    const pending = new Set<Promise<ToolCallResult>>();

    async function run(workerName: string, prompt: string, call: ToolCallOptions, signal: AbortSignal): Promise<DelegationResult> {
        const started = Date.now();
        const worker = workers.get(workerName)!;
        let client: SessionClient | undefined, tools: IValidatedToolRuntime | undefined, sessionId: string | undefined;
        let calls = 0, receipts = 0;
        const result: DelegationResult = { worker: workerName, status: 'failed', answer: '', truncated: false, usageComplete: true, modelCalls: 0, toolCalls: 0, elapsedMs: 0 };
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(new Error('Worker deadline exceeded')), timeoutMs);
        const childSignal = AbortSignal.any([signal, deadline.signal]);
        const cancel = () => { if (client && sessionId) void client.cancel(sessionId).catch(() => undefined); };
        childSignal.addEventListener('abort', cancel);
        try {
            childSignal.throwIfAborted();
            tools = await (worker.tools?.(childSignal) ?? emptyTools());
            childSignal.throwIfAborted();
            const names = new Set(tools.tools().map(tool => tool.name));
            if ([...names].some(name => name === 'delegate' || tools!.effectFor?.(name) !== 'read')) {
                throw new Error('Worker tools must explicitly declare read-only effects; delegation is excluded');
            }
            const admit = () => {
                childSignal.throwIfAborted();
                if (usedCalls >= maxCalls) throw new Error('Delegation model-call allowance exhausted');
                usedCalls++; calls++;
            };
            const provider: ILLMProvider = {
                configurationIdentity: worker.provider.configurationIdentity,
                capabilities: worker.provider.capabilities,
                async turn(request, opts) { admit(); return worker.provider.turn(request, opts); },
                async structured(request, opts) { admit(); return worker.provider.structured(request, opts); },
                ...(worker.provider.streamTurn ? { async streamTurn(request, onDelta, opts) {
                    admit(); return worker.provider.streamTurn!(request, onDelta, opts);
                } } satisfies Pick<ILLMProvider, 'streamTurn'> : {}),
            };
            const ownedTools = tools;
            client = await createHarness().compose({ limits: { timeoutMs, maxModelCalls: workerCalls, maxToolCalls: toolCalls, maxToolCallsPerBatch: toolCalls }, extensions: [{
                id: 'delegation.worker', version: '1', apiVersion: 1,
                roles: {
                    provider: () => provider, store: () => new MemorySessionStore(), tools: () => { tools = undefined; return ownedTools; },
                    context: () => budgetedContext(worker.system, contextTokens),
                    loop: () => conversationalLoop({ maxTurns: workerCalls, maxTokens: outputTokens }),
                    policy: () => ({ evaluate: async context => names.has(context.name) && ownedTools.effectFor?.(context.name) === 'read'
                        ? { kind: 'allow' } : { kind: 'deny', reason: 'Worker capability not enabled' } }),
                },
            }] });
            childSignal.throwIfAborted();
            sessionId = (await client.create(workerName)).id;
            result.sessionId = sessionId;
            childSignal.throwIfAborted();
            await client.submit(sessionId, prompt, { commandId: randomUUID() });
            if (childSignal.aborted) await client.cancel(sessionId);
            const record = await client.wait(sessionId);
            const answer = [...record.messages].reverse().find(message => message.role === 'assistant')?.content ?? '';
            result.answer = answer.slice(0, resultChars);
            result.truncated = answer.length > resultChars;
            result.usage = structuredClone(record.usage);
            receipts = record.operations.filter(operation => operation.kind === 'model' && ['completed', 'partial'].includes(operation.status)).length;
            result.toolCalls = record.operations.filter(operation => operation.kind === 'tool' && operation.dispatched).length;
            result.status = childSignal.aborted || record.status === 'interrupted' ? 'cancelled'
                : record.status === 'idle' && !record.error ? 'completed' : 'failed';
            result.error = record.error;
            await onResult?.(record, { parentSessionId: call.sessionId, callId: call.callId, worker: workerName });
            childSignal.throwIfAborted();
        } catch (error) {
            result.status = childSignal.aborted ? 'cancelled' : 'failed';
            result.error = String(error);
        } finally {
            childSignal.removeEventListener('abort', cancel);
            clearTimeout(timer);
            try {
                if (client) {
                    try {
                        if (sessionId) { await client.cancel(sessionId); await client.wait(sessionId); }
                    } finally { await client.close(); }
                } else await tools?.close?.();
            } catch (error) {
                result.status = 'failed';
                result.error = `${result.error ?? ''} Cleanup failed: ${String(error)}`;
            }
            result.modelCalls = calls;
            result.usageComplete = calls === receipts;
            if (result.error) result.error = result.error.slice(0, resultChars);
            result.elapsedMs = Date.now() - started;
        }
        return result;
    }

    const runtime: IValidatedToolRuntime = {
        tools: () => [{ name: 'delegate', description: `Ask read-only workers to research independent tasks. Results are awaited; children have separate context and an explicit child-call allowance. Workers: ${[...workers].map(([name, worker]) => `${name}: ${worker.description}`).join('; ')}`,
            parameters: { ...z.toJSONSchema(schema, { target: 'draft-7' }), type: 'object' } as ToolDefinition['parameters'] }],
        validate(name, args) {
            if (name !== 'delegate') return { ok: false, result: { ok: false, content: 'Unknown delegation tool', errorKind: 'validation' } };
            const parsed = schema.safeParse(args);
            if (!parsed.success) return { ok: false, result: { ok: false, content: parsed.error.message, errorKind: 'validation' } };
            const keys = parsed.data.tasks.map(task => JSON.stringify(task));
            if (new Set(keys).size !== keys.length) return { ok: false, result: { ok: false, content: 'Duplicate tasks', errorKind: 'validation' } };
            return { ok: true, args: parsed.data };
        },
        async call(name, args, call = {}) {
            const checked = runtime.validate(name, args);
            if (!checked.ok) return checked.result;
            if (call.authorizedArgs && !isDeepStrictEqual(checked.args, call.authorizedArgs)) return { ok: false, content: 'Arguments differ from authorization', errorKind: 'policy' };
            if (closed || call.signal?.aborted) return { ok: false, content: 'Delegation closed or cancelled', errorKind: 'cancelled' };
            const tasks = (checked.args as z.infer<typeof schema>).tasks;
            // Reserve the complete batch before any asynchronous factory; no hidden queue.
            if (active + tasks.length > concurrent) return { ok: false, content: 'Delegation concurrency limit exceeded; submit a smaller batch', errorKind: 'runtime' };
            if (usedCalls >= maxCalls) return { ok: false, content: 'Delegation model-call allowance exhausted', errorKind: 'runtime' };
            active += tasks.length;
            const signal = call.signal ? AbortSignal.any([call.signal, shutdown.signal]) : shutdown.signal;
            const work = Promise.resolve().then(async (): Promise<ToolCallResult> => {
                try {
                    const results = await Promise.all(tasks.map(task => run(task.worker, task.prompt, call, signal)));
                    const ok = results.every(result => result.status === 'completed');
                    return { ok, content: JSON.stringify(results), data: results, ...(!ok ? { errorKind: signal.aborted ? 'cancelled' as const : 'runtime' as const } : {}) };
                } finally { active -= tasks.length; }
            });
            pending.add(work);
            try { return await work; } finally { pending.delete(work); }
        },
        close() {
            closed = true;
            shutdown.abort(new Error('Delegation closed'));
            return closing ??= Promise.allSettled([...pending]).then(() => undefined);
        },
    };
    return runtime;
}
