import { describe, expect, it, vi } from 'vitest';
import type {
    ILLMProvider,
    Message,
    ProviderCallOptions,
    TurnRequest,
    TurnResponse,
} from '../contracts/llm.js';
import { LLMProtocolError } from '../contracts/llm.js';
import type { ITool } from '../contracts/ITool.js';
import type { IToolPolicy } from '../contracts/IToolPolicy.js';
import type { AgentEvent } from '../contracts/agent.js';
import type { IValidatedToolRuntime } from '../contracts/tool-runtime.js';
import { ToolRuntimeAdapter } from '../tools/adapter.js';
import { runAgentKernel } from './AgentKernel.js';

const usage = { inputTokens: 1, outputTokens: 1 };

function providerWith(responses: TurnResponse[]): ILLMProvider {
    let index = 0;
    return {
        async turn() { return responses[index++]!; },
        async structured() { throw new Error('not used'); },
        async embed() { return []; },
    };
}

function text(content: string): TurnResponse {
    return { message: { role: 'assistant', content }, stopReason: 'end_turn', usage };
}

function toolTurn(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): TurnResponse {
    return {
        message: { role: 'assistant', content: '', toolCalls: calls },
        stopReason: 'tool_use',
        usage,
    };
}

function stringTool(execute = vi.fn(async ({ value }: { value: string }) => ({ value }))): {
    tool: ITool<{ value: string }, { value: string }>;
    execute: typeof execute;
} {
    return {
        execute,
        tool: {
            name: 'write_value',
            description: 'Write a string value.',
            trustTier: 'standard',
            input: {
                jsonSchema: {
                    type: 'object',
                    properties: { value: { type: 'string' } },
                    required: ['value'],
                    additionalProperties: false,
                },
                validate(value) {
                    const candidate = value as { value?: unknown };
                    return typeof candidate?.value === 'string'
                        ? { ok: true, value: { value: candidate.value } }
                        : { ok: false, issues: [{ path: ['value'], message: 'must be a string' }] };
                },
            },
            output: {
                jsonSchema: { type: 'object' },
                validate(value) {
                    return { ok: true, value: value as { value: string } };
                },
            },
            execute,
        },
    };
}

describe('runAgentKernel', () => {
    it('distinguishes provider protocol failures from transport failures', async () => {
        const conversation: Message[] = [{ role: 'user', content: 'hello' }];
        const provider: ILLMProvider = {
            async turn() { throw new LLMProtocolError('invalid provider response'); },
            async structured() { throw new Error('not used'); },
            async embed() { return []; },
        };
        const records = await runAgentKernel(
            conversation,
            { provider, tools: new ToolRuntimeAdapter([]) },
            () => ({ messages: conversation }),
        );
        expect(records[0]!.failure).toEqual({
            kind: 'llm_protocol_error',
            message: 'invalid provider response',
        });
    });
    it('passes cancellation to the provider and commits an end turn', async () => {
        const turn = vi.fn(async (_request: TurnRequest, options?: ProviderCallOptions) => {
            expect(options?.signal).toBe(signal);
            return text('done');
        });
        const provider: ILLMProvider = {
            turn,
            async structured() { throw new Error('not used'); },
            async embed() { return []; },
        };
        const signal = new AbortController().signal;
        const conversation: Message[] = [{ role: 'user', content: 'go' }];

        const events: AgentEvent[] = [];
        const records = await runAgentKernel(
            conversation,
            { provider, tools: new ToolRuntimeAdapter([]) },
            () => ({ messages: conversation }),
            event => { events.push(event); },
            signal,
        );

        expect(records).toHaveLength(1);
        expect(records[0]!.outcome).toBe('answered');
        expect(conversation.at(-1)).toMatchObject({ role: 'assistant', content: 'done' });
        expect(events[0]).toEqual({ type: 'agent_start' });
        expect(events.at(-1)).toEqual({ type: 'agent_end', records });
    });

    it('rejects the complete batch before executing when a later call is invalid', async () => {
        const { tool, execute } = stringTool();
        const provider = providerWith([
            toolTurn([
                { id: 'valid', name: 'write_value', args: { value: 'first' } },
                { id: 'invalid', name: 'write_value', args: { value: 42 } },
            ]),
            text('corrected'),
        ]);
        const conversation: Message[] = [{ role: 'user', content: 'write' }];

        const records = await runAgentKernel(
            conversation,
            { provider, tools: new ToolRuntimeAdapter([tool]) },
            () => ({ messages: conversation }),
        );

        expect(execute).not.toHaveBeenCalled();
        expect(records[0]!.executions.map(execution => execution.status)).toEqual([
            'skipped',
            'runtime_failure',
        ]);
        expect(records).toHaveLength(2);
    });

    it('does not authorize any call when raw batch validation fails', async () => {
        const { tool, execute } = stringTool();
        const policy: IToolPolicy = { evaluate: vi.fn(async () => ({ kind: 'allow' as const })) };
        const conversation: Message[] = [{ role: 'user', content: 'write' }];

        await runAgentKernel(
            conversation,
            {
                provider: providerWith([
                    toolTurn([
                        { id: 'valid', name: 'write_value', args: { value: 'safe' } },
                        { id: 'invalid', name: 'write_value', args: { value: 42 } },
                    ]),
                    text('corrected'),
                ]),
                tools: new ToolRuntimeAdapter([tool]),
                policy,
            },
            () => ({ messages: conversation }),
        );

        expect(policy.evaluate).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
    });

    it('revalidates policy rewrites before any tool executes', async () => {
        const { tool, execute } = stringTool();
        const policy: IToolPolicy = {
            async evaluate(context) {
                return context.callId === 'rewrite'
                    ? { kind: 'rewrite', args: { value: false }, reason: 'test rewrite' }
                    : { kind: 'allow' };
            },
        };
        const conversation: Message[] = [{ role: 'user', content: 'write' }];
        const records = await runAgentKernel(
            conversation,
            {
                provider: providerWith([
                    toolTurn([
                        { id: 'allowed', name: 'write_value', args: { value: 'safe' } },
                        { id: 'rewrite', name: 'write_value', args: { value: 'before' } },
                    ]),
                    text('corrected'),
                ]),
                tools: new ToolRuntimeAdapter([tool]),
                policy,
            },
            () => ({ messages: conversation }),
        );

        expect(execute).not.toHaveBeenCalled();
        expect(records[0]!.executions[1]!.error).toContain('must be a string');
    });

    it('fails confirmation closed when no resolver exists', async () => {
        const { tool, execute } = stringTool();
        const policy: IToolPolicy = {
            async evaluate() { return { kind: 'confirm', reason: 'user approval required' }; },
        };
        const conversation: Message[] = [{ role: 'user', content: 'write' }];
        const records = await runAgentKernel(
            conversation,
            {
                provider: providerWith([
                    toolTurn([{ id: 'confirm', name: 'write_value', args: { value: 'x' } }]),
                    text('denied'),
                ]),
                tools: new ToolRuntimeAdapter([tool]),
                policy,
            },
            () => ({ messages: conversation }),
        );

        expect(execute).not.toHaveBeenCalled();
        expect(records[0]!.executions[0]!.status).toBe('policy_denied');
    });

    it('fails confirmation closed when the resolver throws', async () => {
        const { tool, execute } = stringTool();
        const conversation: Message[] = [{ role: 'user', content: 'write' }];
        const records = await runAgentKernel(
            conversation,
            {
                provider: providerWith([
                    toolTurn([{ id: 'confirm', name: 'write_value', args: { value: 'x' } }]),
                    text('denied'),
                ]),
                tools: new ToolRuntimeAdapter([tool]),
                policy: { async evaluate() { return { kind: 'confirm', reason: 'approval required' }; } },
                confirmToolCall: async () => { throw new Error('confirmation service unavailable'); },
            },
            () => ({ messages: conversation }),
        );

        expect(execute).not.toHaveBeenCalled();
        expect(records[0]!.executions[0]).toMatchObject({
            status: 'policy_denied',
            error: expect.stringContaining('failed closed'),
        });
    });

    it('normalizes before-model extension failures and closes the lifecycle', async () => {
        const conversation: Message[] = [{ role: 'user', content: 'write' }];
        const events: AgentEvent[] = [];
        const records = await runAgentKernel(
            conversation,
            { provider: providerWith([]), tools: new ToolRuntimeAdapter([]),
                beforeModelCall: async () => { throw new Error('assembly hook broke'); } },
            () => ({ messages: conversation }),
            event => { events.push(event); },
        );

        expect(records[0]).toMatchObject({ outcome: 'failed', failure: { kind: 'extension_error' } });
        expect(events.map(event => event.type)).toEqual([
            'agent_start', 'turn_start', 'turn_end', 'error', 'agent_end',
        ]);
    });

    it('normalizes a tool runtime that violates the no-throw contract', async () => {
        const runtime: IValidatedToolRuntime = {
            tools: () => [{ name: 'broken', description: 'breaks', parameters: { type: 'object' } }],
            validate: (_name, args) => ({ ok: true, args }),
            async call() { throw new Error('runtime escaped'); },
        };
        const conversation: Message[] = [{ role: 'user', content: 'run' }];
        const records = await runAgentKernel(
            conversation,
            { provider: providerWith([
                toolTurn([{ id: 'broken-call', name: 'broken', args: {} }]),
                text('handled'),
            ]), tools: runtime },
            () => ({ messages: conversation }),
        );

        expect(records[0]!.executions[0]).toMatchObject({
            status: 'runtime_failure',
            error: expect.stringContaining('violated call() contract'),
        });
    });

    it('reconciles completed tools and stops when steering retrieval throws', async () => {
        const { tool, execute } = stringTool();
        const conversation: Message[] = [{ role: 'user', content: 'write twice' }];
        const records = await runAgentKernel(
            conversation,
            {
                provider: providerWith([toolTurn([
                    { id: 'first', name: 'write_value', args: { value: 'a' } },
                    { id: 'second', name: 'write_value', args: { value: 'b' } },
                ])]),
                tools: new ToolRuntimeAdapter([tool]),
                getSteeringMessages: async () => { throw new Error('steering store unavailable'); },
            },
            () => ({ messages: conversation }),
        );

        expect(execute).toHaveBeenCalledTimes(1);
        expect(records[0]).toMatchObject({ outcome: 'failed', failure: { kind: 'extension_error' } });
        expect(records[0]!.executions.map(execution => execution.status)).toEqual(['success', 'skipped']);
        expect(conversation.slice(-3).map(message => message.role)).toEqual([
            'assistant', 'tool_result', 'tool_result',
        ]);
    });

    it('treats duplicate tool-call identifiers as a protocol failure', async () => {
        const { tool, execute } = stringTool();
        const conversation: Message[] = [{ role: 'user', content: 'write' }];
        const records = await runAgentKernel(
            conversation,
            {
                provider: providerWith([toolTurn([
                    { id: 'duplicate', name: 'write_value', args: { value: 'a' } },
                    { id: 'duplicate', name: 'write_value', args: { value: 'b' } },
                ])]),
                tools: new ToolRuntimeAdapter([tool]),
            },
            () => ({ messages: conversation }),
        );

        expect(execute).not.toHaveBeenCalled();
        expect(records[0]!.failure?.kind).toBe('llm_protocol_error');
    });
});
