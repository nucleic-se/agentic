import { sessionSummary } from './session-summary.js';
import { isDeepStrictEqual } from 'node:util';
import { checkpointView, prepareCheckpoint, checkpointFromResponse } from './checkpoint.js';
import type { PreparedHarnessModel } from './execution.js';
import { toToolResultMessage } from '../ToolOutput.js';
import { validateOperationResolution } from './resolution.js';
import { randomUUID } from 'node:crypto';
import type { Message, TurnRequest, TurnResponse, TokenUsage } from '../../contracts/llm.js';
import { composeDriver, compositionFingerprint, type DriverComposition, type HarnessClient } from './composition.js';
import { createHarnessExecution } from './execution.js';
import { commitJournalTransition } from '../ExecutionJournal.js';
import type { ExecutionLimits } from '../ExecutionOptions.js';
import type { OperationResolution, SessionPage } from './types.js';
import type { Extension, HarnessRoles, RoleName, SessionClient, SessionRecord, SessionUpdate, SessionEvent, LoopServices, PendingApproval, SubmitOptions, MaintenanceOptions } from './types.js';

const REQUIRED: RoleName[] = ['store', 'loop', 'context', 'provider', 'tools', 'policy'];
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function assertId(id: string) { if (!/^[a-zA-Z0-9._-]{1,128}$/.test(id)) throw new Error('Invalid identifier'); }

function reconcileInterruptedMessages(record: SessionRecord) {
    const result: Message[] = [];
    for (let i = 0; i < record.messages.length; i++) {
        const message = record.messages[i]; result.push(message);
        if (message.role !== 'assistant' || !message.toolCalls?.length) continue;
        const seen = new Set<string>();
        while (record.messages[i + 1]?.role === 'tool_result') {
            const tool = record.messages[++i];
            if (tool.role === 'tool_result') seen.add(tool.toolCallId);
            result.push(tool);
        }
        for (const call of message.toolCalls) if (!seen.has(call.id)) result.push({
            role: 'tool_result', toolCallId: call.id, toolName: call.name, isError: true,
            content: 'Run interrupted without a committed tool result. This action was not automatically repeated. Check execution history before retrying.',
        });
    }
    if (!isDeepStrictEqual(record.messages, result)) { delete record.checkpoint; delete record.checkpointRejection; }
    record.messages = result;
}

interface SessionComposition { extensions: Extension[]; limits?: ExecutionLimits }
function compose(options: SessionComposition): Promise<SessionClient>;
function compose<Roles extends object, Client extends HarnessClient>(options: DriverComposition<Roles, Client>): Promise<Client>;
function compose<Roles extends object, Client extends HarnessClient>(
    options: SessionComposition | DriverComposition<Roles, Client>,
): Promise<SessionClient | Client> {
    if ('driver' in options) return composeDriver(options);
    const limits = { maxModelCalls: 40, maxToolCalls: 100, maxToolCallsPerBatch: 16, timeoutMs: 600000, ...options.limits };
    for (const [key, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1 || (key === 'timeoutMs' && value > 2147483647)) return Promise.reject(new RangeError(`Invalid execution limit: ${key}`));
    return composeDriver<HarnessRoles, SessionClient>({ extensions: options.extensions, driver: {
        roles: REQUIRED,
        dispose: { store: store => store.close(), tools: tools => tools.close?.() },
        async start(roles, extensions) {
            const client = new HarnessSessionClient(roles, extensions, limits);
            try { await client.recover(); return client; }
            catch (error) { await client.close(); throw error; }
        },
    } });
}

/** The local session driver is the default composition, not a requirement of the harness. */
export function createHarness() { return { compose }; }

class HarnessSessionClient implements SessionClient {
    private readonly locks = new Map<string, Promise<unknown>>();
    private readonly runs = new Map<string, { controller: AbortController; promise: Promise<void> }>();
    private readonly approvals = new Map<string, { resolve: (allow: boolean) => void; sessionId: string; runId: string }>();
    private readonly listeners = new Set<(event: SessionUpdate) => void>();
    private readonly notifications = new Map<string, SessionUpdate>();
    private notifying = false;
    private closed = false;
    private closing = false;
    private closePromise?: Promise<void>;
    private readonly fingerprint: string;
    private readonly execution;
    constructor(private readonly roles: HarnessRoles, private readonly extensions: Extension[], private readonly limits: Required<ExecutionLimits>) {
        this.execution = createHarnessExecution(roles);
        this.fingerprint = compositionFingerprint(extensions);
    }
    composition() { return this.extensions.map(e => ({ id: e.id, version: e.version, roles: Object.keys(e.roles ?? {}) })); }
    private assertAdmission() { this.assertOpen(); if (this.closing) throw new Error('Harness is shutting down'); }
    private assertOpen() { if (this.closed) throw new Error('Harness is closed'); }
    private notify(event: SessionUpdate) {
        const key = `${event.sessionId}:${event.type}:${event.operationId ?? ''}`;
        const previous = this.notifications.get(key);
        this.notifications.set(key, event.type === 'delta' ? { ...event, text: ((previous?.text ?? '') + (event.text ?? '')).slice(-32768) } : event);
        if (this.notifying) return;
        this.notifying = true;
        setImmediate(() => {
            this.notifying = false;
            const events = [...this.notifications.values()]; this.notifications.clear();
            for (const event of events) for (const listener of this.listeners) {
                try { Promise.resolve(listener(structuredClone(event))).catch(() => {}); } catch {}
            }
        });
    }
    subscribe(listener: (event: SessionUpdate) => void) { this.assertOpen(); this.listeners.add(listener); return () => this.listeners.delete(listener); }
    private locked<T>(id: string, action: () => Promise<T>): Promise<T> {
        const previous = this.locks.get(id) ?? Promise.resolve();
        const next = previous.catch(() => {}).then(action);
        this.locks.set(id, next);
        void next.finally(() => { if (this.locks.get(id) === next) this.locks.delete(id); }).catch(() => {});
        return next;
    }
    async get(id: string) { this.assertOpen(); assertId(id); const record = await this.roles.store.get(id); if (!record) throw new Error('Session not found'); return record; }
    async list(page?: SessionPage) { this.assertOpen(); return (await this.roles.store.list(page)).map(sessionSummary); }
    async events(id: string, afterSequence = 0, limit?: number) { await this.get(id); return this.roles.store.events(id, afterSequence, limit); }
    private async change(id: string, type: string, update: (record: SessionRecord) => void, data?: unknown) {
        return this.locked(id, async () => {
            this.assertOpen();
            const record = await commitJournalTransition(this.roles.store, id, {
                update(record) { update(record); record.updatedAt = Date.now(); },
                event: record => ({ schemaVersion: 1, id: randomUUID(), sessionId: id, runId: record.activeRunId,
                    sequence: record.revision, type, timestamp: record.updatedAt, data } as SessionEvent),
            });
            this.notify({ sessionId: id, type: 'changed', revision: record.revision, runId: record.activeRunId });
            return record;
        });
    }
    private addUsage(record: SessionRecord, usage: TokenUsage) {
        for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens', 'costUsd'] as const) {
            if (usage[key] !== undefined) record.usage[key] = (record.usage[key] ?? 0) + usage[key];
        }
    }
    private async executeModelEffect(id: string, runId: string, request: TurnRequest, signal: AbortSignal,
        options: { projection?: 'conversation' | 'none'; maintenance?: MaintenanceOptions; prepared?: PreparedHarnessModel; checkpoint?: NonNullable<Awaited<ReturnType<typeof prepareCheckpoint>>> } = {}): Promise<TurnResponse> {
        signal.throwIfAborted();
        const input = { ...request, cacheScope: request.cacheScope ?? `${this.fingerprint}:${id}`, tools: request.tools ?? this.roles.tools.tools() };
        const operationId = randomUUID();
        const prepared = options.prepared ?? await this.execution.prepareModel(input, { signal });
        const report = prepared.report;
        return this.execution.dispatchModel(prepared, {
            operationId, signal, stream: true,
            ...(options.maintenance ? { requireComplete: true, allowToolCalls: false } : options.checkpoint ? { requireComplete: true } : {}),
            onDelta: text => this.notify({ sessionId: id, runId, operationId, type: 'delta', text }),
            onRequest: async request => { await this.change(id, 'model.request', () => {}, { operationId, request }); },
            onIntent: intent => this.change(id, 'model.intent', record => {
                record.operations.push({ id: intent.operationId, runId, kind: 'model', status: 'intent', requestRef: { sessionId: id, sequence: record.revision + 1 }, createdAt: intent.startedAt });
            }, { operationId, request: intent.request, ...(report ? { contextReport: report } : {}), purpose: options.checkpoint ? 'checkpoint' : options.maintenance ? 'maintenance' : 'task', ...(options.checkpoint ? { sourceRange: options.checkpoint.sourceRange } : {}) }).then(() => undefined),
            onOutcome: async outcome => {
                const completed = outcome.outcome === 'completed' || outcome.outcome === 'partial';
                const data: Record<string, unknown> = { operationId, outcome: outcome.outcome, dispatched: outcome.dispatched, durationMs: outcome.durationMs };
                let projectionError: unknown;
                let projectionFailed = false;
                await this.change(id, completed ? 'model.completed' : 'model.failed', record => {
                    const op = record.operations.find(operation => operation.id === operationId);
                    if (!op || op.status !== 'intent') throw new Error('Model receipt has no pending journal intent');
                    op.dispatched = outcome.dispatched;
                    if ('response' in outcome) {
                        op.status = outcome.outcome; op.output = outcome.response;
                        this.addUsage(record, outcome.usage);
                        if (options.checkpoint && outcome.outcome === 'completed' && !signal.aborted) {
                            const draft = checkpointFromResponse(options.checkpoint, outcome.response);
                            if (draft.ok) {
                                record.checkpoint = draft.checkpoint;
                                delete record.checkpointRejection;
                                data.checkpointDecision = { accepted: true };
                            } else {
                                const attempt = record.checkpointRejection ? 2 : 1;
                                record.checkpointRejection = draft.reason;
                                data.checkpointDecision = { accepted: false, reason: draft.reason, attempt };
                                if (attempt === 2) {
                                    projectionFailed = true;
                                    projectionError = new Error(`Checkpoint rejected after two attempts: ${draft.reason}`);
                                }
                            }
                        } else if (options.maintenance && outcome.outcome === 'completed' && !signal.aborted) {
                            try {
                                const messages = options.maintenance.project(structuredClone(outcome.response), structuredClone(record));
                                if (!Array.isArray(messages) || messages.some(message => !message || !['user', 'assistant', 'tool_result'].includes(message.role) || typeof message.content !== 'string')) throw new Error('Maintenance projector returned invalid messages');
                                data.previousMessages = structuredClone(record.messages);
                                data.messages = structuredClone(messages);
                                record.messages = structuredClone(messages);
                                delete record.checkpoint; delete record.checkpointRejection;
                            } catch (error) { projectionFailed = true; projectionError = error; }
                        } else if (!options.maintenance && !options.checkpoint && options.projection !== 'none' && outcome.outcome === 'completed') {
                            record.messages.push(structuredClone(outcome.response.message));
                        }
                    } else {
                        op.status = outcome.outcome === 'aborted' ? (outcome.dispatched ? 'unknown' : 'cancelled')
                            : outcome.dispatched && outcome.failure.kind === 'transport' ? 'unknown' : 'failed';
                        op.output = outcome.failure;
                        if (outcome.usage) this.addUsage(record, outcome.usage);
                    }
                }, data);
                // Preserve the successful model receipt even when a consumer's projector is invalid.
                if (projectionFailed) throw projectionError;
            },
        });
    }
    private async requestConversation(id: string, runId: string, request: TurnRequest, signal: AbortSignal,
        policy: { maxTokens: number; triggerRatio?: number }, admit: () => void): Promise<TurnResponse> {
        const initial = await this.get(id);
        if (!isDeepStrictEqual(request.messages, initial.messages))
            throw new Error('Checkpointing requires the complete current conversation');
        for (;;) {
            signal.throwIfAborted();
            const record = await this.get(id);
            const view = checkpointView(record.messages, record.checkpoint);
            const prepared = await this.execution.prepareModel({ ...request, messages: view.messages,
                tools: request.tools ?? this.roles.tools.tools(), cacheScope: request.cacheScope ?? `${this.fingerprint}:${id}` }, { signal });
            if (!prepared.report) throw new Error('Checkpointing requires a context usage report');
            const checkpoint = await prepareCheckpoint(this.execution, record.messages, view, prepared.report, {
                ...policy, previous: record.checkpoint, rejection: record.checkpointRejection,
                cacheScope: `${this.fingerprint}:${id}:checkpoint`,
            }, { signal });
            admit();
            if (!checkpoint) return this.executeModelEffect(id, runId, request, signal, { prepared });
            await this.executeModelEffect(id, runId, checkpoint.prepared.request, signal, {
                prepared: checkpoint.prepared, checkpoint,
            });
        }
    }
    async recover() {
        for (const session of await this.roles.store.list()) {
            if (session.status !== 'running' && session.status !== 'waiting') continue;
            await this.change(session.id, 'run.recovered', record => {
                for (const op of record.operations) if (op.status === 'intent') op.status = 'unknown';
                // No approval remains executable after process recovery.
                reconcileInterruptedMessages(record);
                record.approvals = []; record.status = 'interrupted'; delete record.activeRunId;
                record.error = 'Previous run was interrupted. Review unknown operations before resuming; no operation will be repeated automatically.';
            });
        }
    }
    async create(title = 'New session') {
        this.assertAdmission();
        const now = Date.now();
        const record: SessionRecord = { id: randomUUID(), title: title.trim().slice(0, 120) || 'New session', revision: 0, createdAt: now, updatedAt: now, status: 'idle', messages: [], operations: [], approvals: [], commandIds: [], queue: [], usage: { inputTokens: 0, outputTokens: 0 }, composition: this.fingerprint };
        return this.locked(record.id, async () => {
            await this.roles.store.create(record);
            this.notify({ sessionId: record.id, type: 'changed', revision: 0 });
            return structuredClone(record);
        });
    }
    async fork(id: string) {
        this.assertAdmission();
        return this.locked(id, async () => {
            const parent = await this.get(id);
            if (this.runs.has(id) || parent.status === 'running' || parent.status === 'waiting') throw new Error('Cancel or finish the run before forking');
            if (parent.operations.some(op => op.kind === 'tool' && op.status === 'unknown')) throw new Error('Cannot fork a session with unknown tool outcomes');
            const now = Date.now();
            const child: SessionRecord = { ...structuredClone(parent), id: randomUUID(), title: `${parent.title} (fork)`.slice(0,120), revision: 0, createdAt: now, updatedAt: now, status: 'idle', parent: { sessionId: id, revision: parent.revision }, approvals: [], queue: [], commandIds: [] };
            delete child.activeRunId; delete child.error;
            await this.roles.store.create(child); this.notify({ sessionId: child.id, type: 'changed', revision: 0 }); return child;
        });
    }
    private checkRunnable(record: SessionRecord) {
        if (record.composition !== this.fingerprint) throw new Error('Session composition differs from this harness; open with its original extensions');
        if (record.operations.some(op => op.kind === 'tool' && op.status === 'unknown')) throw new Error('Unknown tool outcome requires manual reconciliation; resolve the operation with evidence or start a new session');
    }
    async submit(id: string, content: string, options: SubmitOptions) {
        this.assertAdmission();
        if (typeof content !== 'string' || !content.trim() || content.length > 32000) throw new Error('Message must contain 1–32000 characters');
        assertId(options.commandId);
        if (options.mode && options.mode !== 'steer' && options.mode !== 'enqueue') throw new Error('Invalid delivery mode');
        let accepted = false;
        await this.change(id, 'input.accepted', record => {
            this.checkRunnable(record);
            if (record.commandIds.includes(options.commandId)) return;
            record.commandIds.push(options.commandId);
            record.queue.push({ id: options.commandId, content: content.trim(), mode: options.mode ?? 'enqueue' });
            accepted = true;
            if (record.title === 'New session') record.title = content.trim().slice(0, 80);
        }, { commandId: options.commandId });
        if (accepted && !this.runs.has(id)) this.launch(id);
    }
    async resume(id: string) {
        this.assertAdmission();
        const record = await this.get(id); this.checkRunnable(record);
        if (this.runs.has(id)) throw new Error('Session is already running');
        if (!record.messages.length && !record.queue.length) throw new Error('Session has no input');
        this.launch(id);
    }
    async wait(id: string) {
        await this.get(id);
        while (this.runs.has(id)) await this.runs.get(id)!.promise.catch(() => undefined);
        return this.get(id);
    }
    async replaceMessages(id: string, expectedRevision: number, messages: Message[]) {
        this.assertAdmission();
        const replacement = structuredClone(messages);
        return this.locked(id, async () => {
            const record = await this.get(id);
            if (this.runs.has(id) || record.status === 'running' || record.status === 'waiting') throw new Error('Cannot replace messages during a run');
            this.checkRunnable(record);
            if (record.revision !== expectedRevision) throw new Error('Session revision conflict');
            if (record.queue.length) throw new Error('Cannot replace messages with pending input');
            const previous = record.messages;
            record.messages = replacement; delete record.checkpoint; delete record.checkpointRejection; record.revision++; record.updatedAt = Date.now();
            await this.roles.store.commit(id, expectedRevision, record, {
                schemaVersion: 1, id: randomUUID(), sessionId: id, sequence: record.revision,
                type: 'messages.replaced', timestamp: record.updatedAt,
                data: { previousMessages: previous, messages: replacement },
            });
            this.notify({ sessionId: id, type: 'changed', revision: record.revision });
            return structuredClone(record);
        });
    }
    async resolveOperation(id: string, operationId: string, resolution: OperationResolution): Promise<SessionRecord> {
        this.assertAdmission(); assertId(id); assertId(operationId);
        const input = validateOperationResolution(resolution);
        return this.change(id, 'tool.resolved', record => {
            if (this.runs.has(id) || record.status === 'running' || record.status === 'waiting') throw new Error('Finish the run before resolving an operation');
            if (record.revision !== input.expectedRevision) throw new Error('Session revision conflict');
            const op = record.operations.find(item => item.id === operationId);
            if (!op || op.kind !== 'tool' || op.status !== 'unknown') throw new Error('Operation is not an unresolved tool effect');
            const previous = op.output as import('../../contracts/agent.js').ToolExecution | undefined;
            const callId = op.callId ?? previous?.callId;
            if (!callId) throw new Error('Legacy operation lacks a tool call identity; start a new session');
            op.status = input.result.ok ? 'completed' : 'failed';
            op.output = { previous: op.output, resolution: input };
            const message = toToolResultMessage({ id: callId, name: op.name }, { ...input.result, content: input.result.content.length > 16000 ? input.result.content.slice(0,16000) + '\n[truncated]' : input.result.content });
            let index = record.messages.length - 1;
            while (index >= 0) { const item = record.messages[index]; if (item.role === 'tool_result' && item.toolCallId === callId) break; index--; }
            delete record.checkpoint; delete record.checkpointRejection;
            if (index >= 0) record.messages[index] = message;
            else record.messages.push(message);
            if (!record.operations.some(item => item.kind === 'tool' && item.status === 'unknown')) { record.status = 'interrupted'; delete record.error; }
        }, { operationId, ...input });
    }
    async maintain(id: string, options: MaintenanceOptions): Promise<SessionRecord> {
        this.assertAdmission(); assertId(id);
        if (!options.system?.trim() || options.system.length > 32000 || typeof options.project !== 'function') throw new Error('Maintenance requires a system instruction and pure projector');
        const maxTokens = options.maxTokens ?? 4096;
        if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error('Maintenance maxTokens must be a positive safe integer');
        if (this.runs.has(id)) throw new Error('Session is already running');
        const controller = new AbortController();
        const maintenance = { ...options, maxTokens };
        let result: SessionRecord | undefined;
        const promise = Promise.resolve().then(async () => {
            result = await this.runMaintenance(id, maintenance, controller);
        }).finally(async () => {
            this.runs.delete(id);
            if (!this.closed && !this.closing && !controller.signal.aborted) {
                const record = await this.get(id);
                if (record.status === 'idle' && record.queue.length) this.launch(id);
            }
        });
        // Reserve before the first await so input, cancel and shutdown observe the maintenance run.
        this.runs.set(id, { controller, promise });
        await promise;
        return result!;
    }
    private async runMaintenance(id: string, options: MaintenanceOptions, controller: AbortController): Promise<SessionRecord> {
        const runId = randomUUID(), signal = controller.signal;
        const timer = setTimeout(() => controller.abort(new Error('Maintenance deadline exceeded')), this.limits.timeoutMs);
        let started = false;
        try {
            const current = await this.change(id, 'maintenance.started', record => {
                signal.throwIfAborted(); this.checkRunnable(record);
                if (record.status === 'running' || record.status === 'waiting' || record.queue.length) throw new Error('Maintenance requires a session without active or queued work');
                record.status = 'running'; record.activeRunId = runId; delete record.error;
            });
            started = true;
            await this.executeModelEffect(id, runId, { system: options.system, messages: current.messages, tools: [], maxTokens: options.maxTokens }, signal, { maintenance: options });
            signal.throwIfAborted();
            return await this.change(id, 'maintenance.completed', record => { record.status = 'idle'; delete record.activeRunId; });
        } catch (error) {
            if (started) await this.change(id, 'maintenance.failed', record => {
                record.status = signal.aborted ? 'interrupted' : 'failed'; record.error = errorText(error);
                for (const operation of record.operations) if (operation.runId === runId && operation.status === 'intent') operation.status = 'unknown';
                delete record.activeRunId;
            }).catch(() => undefined);
            throw error;
        } finally { clearTimeout(timer); }
    }
    async cancel(id: string) {
        await this.get(id);
        this.runs.get(id)?.controller.abort(new Error('Cancelled by user'));
        for (const pending of this.approvals.values()) if (pending.sessionId === id) pending.resolve(false);
    }
    async approve(id: string, approvalId: string, allow: boolean) {
        this.assertAdmission();
        if (typeof allow !== 'boolean') throw new Error('Approval must be a boolean');
        const pending = this.approvals.get(approvalId);
        if (!pending || pending.sessionId !== id) throw new Error('Approval is stale or belongs to another session');
        await this.change(id, 'approval.resolved', record => {
            if (this.runs.get(id)?.controller.signal.aborted || record.activeRunId !== pending.runId || !record.approvals.some(a => a.id === approvalId)) throw new Error('Approval is stale');
            record.approvals = record.approvals.filter(a => a.id !== approvalId);
            record.status = 'running';
        }, { approvalId, allow });
        this.approvals.delete(approvalId); pending.resolve(allow);
    }
    private launch(id: string) {
        if (this.runs.has(id) || this.closed || this.closing) return;
        const controller = new AbortController();
        // Reserve synchronously; run work begins in a microtask.
        const promise = Promise.resolve().then(() => this.run(id, controller)).finally(async () => {
            this.runs.delete(id);
            if (!this.closed && !this.closing && !controller.signal.aborted) {
                const record = await this.get(id);
                if (record.status === 'idle' && record.queue.length) this.launch(id);
            }
        });
        this.runs.set(id, { controller, promise });
        void promise.catch(() => {});
    }
    private async run(id: string, controller: AbortController) {
        const runId = randomUUID(); const signal = controller.signal;
        let modelCount = 0; let toolCount = 0;
        const timer = setTimeout(() => controller.abort(new Error('Run deadline exceeded')), this.limits.timeoutMs);
        try {
            await this.change(id, 'run.started', record => { this.checkRunnable(record); record.status = 'running'; record.activeRunId = runId; delete record.error; });
            const takeQueued = async (mode: 'steer' | 'enqueue'): Promise<Message[]> => {
                const picked: Message[] = [];
                await this.change(id, 'input.delivered', record => {
                    const selected = record.queue.filter(item => item.mode === mode);
                    record.queue = record.queue.filter(item => item.mode !== mode);
                    for (const item of selected) picked.push({ role: 'user', content: item.content });
                    record.messages.push(...picked);
                });
                return picked;
            };
            const append = async (messages: Message[]) => {
                if (!messages.length) return;
                await this.change(id, 'messages.appended', record => { record.messages.push(...structuredClone(messages)); }, messages);
            };
            await takeQueued('steer'); await takeQueued('enqueue');
            const services: LoopServices = {
                signal,
                // Raw request snapshot; the model effect assembles once after loop overrides are final.
                context: async () => { signal.throwIfAborted(); return { messages: (await this.get(id)).messages }; },
                messages: async () => (await this.get(id)).messages,
                append, takeQueued,
                model: { request: async (request, options) => {
                    const admit = () => {
                        if (++modelCount > this.limits.maxModelCalls) throw new Error('Run model-call budget exceeded');
                    };
                    if (options?.checkpoint) {
                        if (options.projection === 'none') throw new Error('Checkpointing requires conversation projection');
                        return this.requestConversation(id, runId, request, signal, options.checkpoint, admit);
                    }
                    admit();
                    return this.executeModelEffect(id, runId, request, signal, { projection: options?.projection });
                } },
                tools: { executeBatch: async calls => {
                    signal.throwIfAborted();
                    toolCount += calls.length;
                    if (toolCount > this.limits.maxToolCalls) throw new Error('Run tool-call budget exceeded');
                    const operationIds = new Map<string, string>();
                    const { executions } = await this.execution.tools(calls, {
                        tools: this.roles.tools, policy: this.roles.policy, signal, sessionId: id, maxToolCallsPerTurn: this.limits.maxToolCallsPerBatch,
                        confirmToolCall: async context => {
                            signal.throwIfAborted();
                            const approval: PendingApproval = { ...structuredClone(context), id: randomUUID(), runId, createdAt: Date.now() };
                            let resolve!: (allow: boolean) => void;
                            const decision = new Promise<boolean>(r => { resolve = r; });
                            this.approvals.set(approval.id, { sessionId: id, runId, resolve });
                            const aborted = () => resolve(false);
                            signal.addEventListener('abort', aborted, { once: true });
                            try {
                                await this.change(id, 'approval.requested', record => { record.approvals.push(approval); record.status = 'waiting'; });
                                if (signal.aborted) return false;
                                return await decision;
                            } finally {
                                signal.removeEventListener('abort', aborted); this.approvals.delete(approval.id);
                            }
                        },
                        emit: async event => {
                            if (event.type === 'tool_start') {
                                const operationId = randomUUID(); operationIds.set(event.callId, operationId);
                                await this.change(id, 'tool.intent', record => { record.operations.push({ id: operationId, runId, kind: 'tool', status: 'intent', name: event.name, callId: event.callId, input: event.input, createdAt: Date.now() }); });
                            } else if (event.type === 'tool_end') {
                                const operationId = operationIds.get(event.callId);
                                await this.change(id, 'tool.completed', record => {
                                    if (operationId) {
                                        const op = record.operations.find(o => o.id === operationId)!;
                                        op.dispatched = event.execution.dispatched;
                                        op.status = ['unknown', 'timeout', 'cancelled'].includes(event.execution.status) ? (event.execution.dispatched === false ? 'cancelled' : 'unknown') : event.execution.status === 'success' ? 'completed' : 'failed';
                                        op.output = event.execution;
                                    }
                                    const execution = event.execution;
                                    const content = execution.result?.content ?? execution.error ?? `Tool call ${execution.status}`;
                                    record.messages.push(toToolResultMessage({ id: execution.callId, name: execution.plan.name }, { ...execution.result, ok: execution.status === 'success', content: content.length > 16000 ? content.slice(0,16000) + '\n[truncated]' : content }));
                                }, event.execution);
                                if (operationId && event.execution.dispatched !== false && (['unknown', 'timeout', 'cancelled'].includes(event.execution.status))) {
                                    throw new Error('Tool outcome is unknown after timeout or cancellation; reconcile before continuing');
                                }
                            }
                        },
                    });
                    if (executions.some(execution => execution.dispatched !== false && ['unknown', 'timeout', 'cancelled'].includes(execution.status))) {
                        throw new Error('Tool outcome is unknown after timeout or cancellation; reconcile before continuing');
                    }
                    if (executions.some(execution => execution.hookFailure)) throw new Error('Post-tool hook failed; effect receipt preserved');
                    return executions;
                } },
            };
            await this.roles.loop.run(services); signal.throwIfAborted();
            await this.change(id, 'run.completed', record => { record.status = 'idle'; record.approvals = []; delete record.activeRunId; });
        } catch (error) {
            await this.change(id, 'run.failed', record => {
                reconcileInterruptedMessages(record);
                record.status = signal.aborted ? 'interrupted' : 'failed'; record.error = errorText(error); record.approvals = [];
                for (const op of record.operations) if (op.runId === runId && op.status === 'intent') op.status = 'unknown';
                delete record.activeRunId;
            }).catch(() => {});
        } finally { clearTimeout(timer); }
    }
    close(): Promise<void> {
        if (this.closePromise) return this.closePromise;
        this.closing = true;
        // Install the shared completion before invoking cancellation callbacks.
        this.closePromise = Promise.resolve().then(() => this.finishClose());
        return this.closePromise;
    }
    private async finishClose() {
        for (const run of this.runs.values()) run.controller.abort(new Error('Harness shutting down'));
        for (const approval of this.approvals.values()) approval.resolve(false);
        await Promise.allSettled([...this.runs.values()].map(run => run.promise));
        // Commands admitted before shutdown may still be committing even when no run exists.
        // Repeat because completing one serialized action can expose its queued successor.
        while (this.locks.size) await Promise.allSettled([...this.locks.values()]);
        this.closed = true; this.listeners.clear();
    }
}
