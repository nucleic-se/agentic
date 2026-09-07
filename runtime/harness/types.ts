import type { ContextLifecycle } from './context-lifecycle.js';
import type { Message, TurnRequest, TurnResponse, ILLMProvider, ToolCall, TokenUsage, ToolDefinition } from '../../contracts/llm.js';
import type { ExecutionJournal } from '../ExecutionJournal.js';
export type { ExecutionLimits } from '../ExecutionOptions.js';
import type { ContextReport } from '../../contracts/IAgentContextAssembler.js';
import type { ToolCallResult } from '../../contracts/tool-runtime.js';
import type { ToolExecution } from '../../contracts/agent.js';
import type { IValidatedToolRuntime } from '../../contracts/tool-runtime.js';
import type { IToolPolicy, PolicyContext } from '../../contracts/IToolPolicy.js';

export type SessionStatus = 'idle' | 'running' | 'waiting' | 'interrupted' | 'failed';
export interface Operation {
    id: string;
    runId: string;
    kind: 'model' | 'tool';
    status: 'intent' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'unknown';
    /** True once dispatch may have reached the external implementation. */
    dispatched?: boolean;
    name?: string;
    callId?: string;
    /** Immutable model intent; inherited operations keep their source session on fork. */
    requestRef?: { sessionId: string; sequence: number };
    /** Tool arguments. Model requests are retrieved from requestRef. */
    input?: unknown;
    output?: unknown;
    /** Operator-verified outcome, separate from the original execution evidence. */
    resolution?: OperationResolution;
    createdAt: number;
}
export interface PendingApproval extends PolicyContext {
    id: string;
    runId: string;
    reason: string;
    createdAt: number;
}
export interface SessionRecord {
    id: string;
    title: string;
    revision: number;
    createdAt: number;
    updatedAt: number;
    status: SessionStatus;
    messages: Message[];
    /** Opaque derived state owned by the configured context lifecycle. */
    contextState?: unknown;
    operations: Operation[];
    approvals: PendingApproval[];
    commandIds: string[];
    queue: Array<{ id: string; content: string; mode: 'steer' | 'enqueue' }>;
    usage: TokenUsage;
    composition: string;
    activeRunId?: string;
    parent?: { sessionId: string; revision: number };
    error?: string;
}
export type SessionSummary = Pick<SessionRecord, 'id' | 'title' | 'revision' | 'createdAt' | 'updatedAt' | 'status'>;
export interface SessionEvent {
    schemaVersion: 1;
    id: string;
    sessionId: string;
    runId?: string;
    sequence: number;
    type: string;
    timestamp: number;
    data?: unknown;
}
export interface SessionUpdate {
    sessionId: string;
    type: 'changed' | 'delta';
    runId?: string;
    operationId?: string;
    text?: string;
    revision?: number;
}
export interface SessionPage { limit: number; offset?: number }

/** A commit atomically persists state and event, rejecting stale revisions. */
export interface SessionStore extends ExecutionJournal<SessionRecord, SessionEvent> {
    create(record: SessionRecord): Promise<void>;
    list(page?: SessionPage): Promise<SessionSummary[]>;
    events(id: string, afterSequence?: number, limit?: number): Promise<SessionEvent[]>;
    close(): Promise<void>;
}
export interface SubmitOptions { commandId: string; mode?: 'steer' | 'enqueue' }
export interface MaintenanceOptions {
    /** Complete maintenance instruction, included in the context budget. */
    system: string;
    maxTokens?: number;
    /** Pure projection of a complete text response. Original messages remain in the journal event. */
    project(response: TurnResponse, current: SessionRecord): Message[];
}
export interface OperationResolution {
    expectedRevision: number;
    /** Caller-obtained evidence of the actual external outcome. */
    evidence: string;
    result: ToolCallResult;
}
/** Shared by terminal, web and embedded consumers. UI attachment never owns a run. */
export interface SessionClient {
    create(title?: string): Promise<SessionRecord>;
    list(page?: SessionPage): Promise<SessionSummary[]>;
    get(id: string): Promise<SessionRecord>;
    events(id: string, afterSequence?: number, limit?: number): Promise<SessionEvent[]>;
    submit(id: string, content: string, options: SubmitOptions): Promise<void>;
    /** Await all currently scheduled work, returning its committed terminal state. */
    wait(id: string): Promise<SessionRecord>;
    /** Replace the model-visible transcript at an idle revision; original history remains in the event. */
    replaceMessages(id: string, expectedRevision: number, messages: Message[]): Promise<SessionRecord>;
    /** Journaled, cancellable model maintenance with atomic receipt/accounting/transcript replacement. */
    maintain(id: string, options: MaintenanceOptions): Promise<SessionRecord>;
    resolveOperation(id: string, operationId: string, resolution: OperationResolution): Promise<SessionRecord>;
    cancel(id: string): Promise<void>;
    approve(id: string, approvalId: string, allow: boolean): Promise<void>;
    fork(id: string): Promise<SessionRecord>;
    resume(id: string): Promise<void>;
    subscribe(listener: (event: SessionUpdate) => void): () => void;
    composition(): Array<{ id: string; version: string; roles: string[] }>;
    close(): Promise<void>;
}
export interface ContextStrategy {
    lifecycle?: ContextLifecycle;
    assemble(messages: Message[], signal: AbortSignal, options?: {
        tools?: ToolDefinition[];
        reservedOutputTokens?: number;
        /** Overrides the normal system instruction and must participate in budgeting. */
        system?: string;
    }): Promise<{ system?: string; messages: Message[]; report?: ContextReport }>;
}
export interface LoopServices {
    readonly signal: AbortSignal;
    readonly model: { request(request: TurnRequest, options?: { projection?: 'conversation' | 'none' }): Promise<TurnResponse> };
    readonly tools: { executeBatch(calls: ToolCall[]): Promise<ToolExecution[]> };
    /** Raw request snapshot. The model service applies the context strategy once, after request overrides. */
    context(): Promise<{ system?: string; messages: Message[] }>;
    messages(): Promise<Message[]>;
    append(messages: Message[]): Promise<void>;
    /** Atomically commits queued user messages; returned messages are already in history. */
    takeQueued(mode: 'steer' | 'enqueue'): Promise<Message[]>;
}
export interface LoopStrategy { run(services: LoopServices): Promise<void> }
export interface HarnessRoles {
    store: SessionStore;
    loop: LoopStrategy;
    context: ContextStrategy;
    provider: ILLMProvider;
    tools: IValidatedToolRuntime;
    policy: IToolPolicy;
}
export type RoleName = keyof HarnessRoles;
export type Extension = import('./composition.js').HarnessExtension<HarnessRoles, SessionClient>;
