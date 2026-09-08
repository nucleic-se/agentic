import { describe, expect, it, vi } from 'vitest';
import { executeToolBatch, executeToolBatchDetailed } from './ToolBatchExecutor.js';
import { runAgentKernel } from './AgentKernel.js';
import type { ILLMProvider, Message, ToolContentBlock } from '../contracts/llm.js';
import type { ToolCall } from '../contracts/llm.js';
import type { AgentEvent } from '../contracts/agent.js';
import type { IValidatedToolRuntime } from '../contracts/tool-runtime.js';

const calls = (): ToolCall[] => [
    { id: 'one', name: 'write', args: { value: 'first' } },
    { id: 'two', name: 'write', args: { value: 'second' } },
];
function runtime(): IValidatedToolRuntime {
    return {
        // Tool execution must not need provider-facing discovery or a synthetic request.
        tools: vi.fn(() => { throw new Error('No model/tool discovery in batch execution'); }),
        validate: vi.fn((_name, args) => typeof args.value === 'string'
            ? { ok: true, args: { ...args } }
            : { ok: false, result: { ok: false, content: 'Expected string value', errorKind: 'validation' } }),
        call: vi.fn(async (_name, args) => ({ ok: true, content: String(args.value), data: { retained: true } })),
    };
}

describe('shared tool batch execution', () => {
    it('runs directly without tool discovery, model requests, or agent/turn lifecycle events', async () => {
        const tools = runtime();
        const events: AgentEvent[] = [];
        const result = await executeToolBatch(calls(), { tools, turnId: 'host-operation', emit: event => { events.push(event); } });
        expect(tools.tools).not.toHaveBeenCalled();
        expect(events.map(event => event.type)).toEqual(['tool_start', 'tool_end', 'tool_start', 'tool_end']);
        expect(events.every(event => 'turnId' in event && event.turnId === 'host-operation')).toBe(true);
        expect(result.map(execution => execution.result?.data)).toEqual([{ retained: true }, { retained: true }]);
    });

    it('preflights the whole batch before authorizing or executing any call', async () => {
        const tools = runtime();
        const evaluate = vi.fn(async () => ({ kind: 'allow' as const }));
        const input = calls(); input[1].args.value = 42;
        const result = await executeToolBatch(input, { tools, policy: { evaluate } });
        expect(evaluate).not.toHaveBeenCalled();
        expect(tools.call).not.toHaveBeenCalled();
        expect(result.map(execution => execution.status)).toEqual(['skipped', 'runtime_failure']);
    });

    it('confirms final rewritten arguments for every call before dispatch', async () => {
        const tools = runtime();
        const approved: unknown[] = [];
        const result = await executeToolBatch(calls(), {
            tools,
            beforeToolCall: ({ args }) => ({ action: 'continue', args: { value: `${args.value}-hook` } }),
            policy: { evaluate: async ({ args }) => ({ kind: 'confirm', reason: 'Review', args: { value: `${args.value}-policy` } }) },
            confirmToolCall: ({ args }) => {
                expect(tools.call).not.toHaveBeenCalled();
                approved.push(structuredClone(args));
                args.value = 'tampered confirmation copy';
                return true;
            },
        });
        expect(approved).toEqual([{ value: 'first-hook-policy' }, { value: 'second-hook-policy' }]);
        expect(result.map(execution => execution.result?.content)).toEqual(['first-hook-policy', 'second-hook-policy']);
        expect(vi.mocked(tools.call).mock.calls.map(call => call[2]?.authorizedArgs)).toEqual(approved);
    });

    it('awaits the durable start sink and never executes if it fails', async () => {
        const tools = runtime();
        await expect(executeToolBatch(calls(), { tools, emit: async event => {
            if (event.type === 'tool_start') throw new Error('Intent commit failed');
        } })).rejects.toThrow('Intent commit failed');
        expect(tools.call).not.toHaveBeenCalled();
    });

    it('does not let a start-event observer change approved arguments', async () => {
        const tools = runtime();
        const result = await executeToolBatch(calls(), {
            tools,
            policy: { evaluate: async () => ({ kind: 'confirm', reason: 'Review' }) },
            confirmToolCall: () => true,
            emit: event => { if (event.type === 'tool_start') (event.input as Record<string, unknown>).value = 'observer changed it'; },
        });
        expect(result.map(execution => execution.result?.content)).toEqual(['first', 'second']);
    });

    it('rechecks cancellation after intent persistence and proves dispatch never occurred', async () => {
        const tools = runtime(); const controller = new AbortController();
        const result = await executeToolBatchDetailed(calls(), { tools, signal: controller.signal,
            emit: async event => { if (event.type === 'tool_start') { await Promise.resolve(); controller.abort(); } },
        });
        expect(tools.call).not.toHaveBeenCalled();
        expect(result.executions).toHaveLength(2);
        expect(result.executions.every(execution => execution.dispatched === false && execution.status === 'cancelled')).toBe(true);
    });

    it('does not dispatch another call after completion persistence fails', async () => {
        const tools = runtime();
        await expect(executeToolBatch(calls(), { tools, emit: async event => {
            if (event.type === 'tool_end') throw new Error('Completion commit failed');
        } })).rejects.toThrow('Completion commit failed');
        expect(tools.call).toHaveBeenCalledTimes(1);
    });

    it('returns steering interruption metadata and reconciles every unexecuted call', async () => {
        const tools = runtime();
        const result = await executeToolBatchDetailed(calls(), {
            tools, getSteeringMessages: async () => [{ role: 'user', content: 'Stop and inspect' }],
        });
        expect(tools.call).toHaveBeenCalledTimes(1);
        expect(result.interruption).toBe('steering');
        expect(result.executions.map(execution => execution.status)).toEqual(['success', 'skipped']);
        expect(result.plans.map(plan => plan.callId)).toEqual(['one', 'two']);
        expect(result.steeringMessages).toEqual([{ role: 'user', content: 'Stop and inspect' }]);
    });

    it('stops between calls on cancellation and retains the completed outcome', async () => {
        const tools = runtime();
        const controller = new AbortController();
        const result = await executeToolBatchDetailed(calls(), {
            tools, signal: controller.signal, emit: event => { if (event.type === 'tool_end') controller.abort(); },
        });
        expect(tools.call).toHaveBeenCalledTimes(1);
        expect(result.interruption).toBe('abort');
        expect(result.executions.map(execution => execution.status)).toEqual(['success', 'cancelled']);
    });

    it('rejects malformed batch identity and budgets before validation', async () => {
        const tools = runtime();
        const duplicate = calls(); duplicate[1].id = duplicate[0].id;
        await expect(executeToolBatch(duplicate, { tools })).rejects.toThrow('duplicate tool call id');
        await expect(executeToolBatch(calls(), { tools, maxToolCallsPerTurn: 1 })).rejects.toThrow('maximum is 1');
        await expect(executeToolBatch(calls(), { tools, maxToolCallsPerTurn: 0 })).rejects.toThrow('positive safe integer');
        expect(tools.validate).not.toHaveBeenCalled();
        expect(tools.call).not.toHaveBeenCalled();
    });

    it.each(['unknown', 'timeout', 'cancelled', 'throw'] as const)('stops the kernel after uncertain dispatch (%s)', async failure => {
        const tools = runtime(); tools.tools = () => [];
        tools.call = vi.fn(async () => {
            if (failure === 'throw') throw new Error('Transport lost after write');
            return { ok: false, content: 'Effect cannot be verified', errorKind: failure };
        });
        const turn = vi.fn(async () => ({ message: { role: 'assistant' as const, content: '', toolCalls: calls() }, stopReason: 'tool_use' as const, usage: { inputTokens: 1, outputTokens: 1 } }));
        const provider: ILLMProvider = { turn, structured: async () => { throw new Error('unused'); }, embed: async () => [] };
        const conversation: Message[] = [];
        const records = await runAgentKernel(conversation, { provider, tools }, () => ({ messages: conversation }));
        expect(turn).toHaveBeenCalledTimes(1);
        expect(tools.call).toHaveBeenCalledTimes(1);
        expect(records[0].failure?.kind).toBe('tool_outcome_unknown');
        expect(records[0].executions.map(execution => execution.status)).toEqual([failure === 'throw' ? 'unknown' : failure, 'skipped']);
        expect(records[0].interrupted?.executedCalls).toEqual(['one']);
        expect(records[0].executions[1].dispatched).toBe(false);
    });

    it.each(['success', 'unknown', 'cancelled'] as const)('preserves the raw receipt when the post-execution hook fails (%s)', async outcome => {
        const tools = runtime();
        const receipt = { ok: outcome === 'success', content: 'Original receipt', ...(outcome === 'success' ? {} : { errorKind: outcome }) };
        tools.call = vi.fn(async () => receipt);
        const result = await executeToolBatchDetailed(calls(), { tools, afterToolCall: ({ result }) => {
            result.content = 'Mutated by hook';
            throw new Error('Formatting failed');
        } });
        expect(tools.call).toHaveBeenCalledTimes(1);
        expect(result.executions[0].status).toBe(outcome);
        expect(result.executions[0].result).toEqual(receipt);
        expect(result.executions[0].rawResult).toEqual(receipt);
        expect(result.executions[0].hookFailure?.kind).toBe('extension_error');
        expect(result.controlFailure?.kind).toBe(outcome === 'success' ? 'extension_error' : 'tool_outcome_unknown');
        expect(result.executions[1].status).toBe('skipped');
    });

    it('keeps transformed presentation separate from the effect receipt', async () => {
        const tools = runtime();
        const result = await executeToolBatch(calls().slice(0, 1), { tools, afterToolCall: ({ result }) => ({ ...result, content: 'Shortened' }) });
        expect(result[0].status).toBe('success');
        expect(result[0].result?.content).toBe('Shortened');
        expect(result[0].rawResult?.content).toBe('first');
    });

    it.each([true, false])('preserves rich tool results through kernel reconciliation (ok=%s)', async ok => {
        const blocks: ToolContentBlock[] = [{ type: 'text', text: 'Screenshot' }, { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }];
        const tools = runtime();
        tools.tools = () => [];
        tools.call = async () => ({ ok, content: 'Screenshot fallback', contentBlocks: blocks, ...(!ok ? { errorKind: 'runtime' as const } : {}) });
        const provider: ILLMProvider = {
            turn: async () => ({ message: { role: 'assistant', content: '', toolCalls: calls().slice(0, 1) }, stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } }),
            structured: async () => { throw new Error('unused'); }, embed: async () => [],
        };
        const conversation: Message[] = [];
        await runAgentKernel(conversation, { provider, tools, maxTurns: 1, autoStop: true }, () => ({ messages: conversation }));
        const result = conversation[1];
        expect(result.role).toBe('tool_result');
        if (result.role !== 'tool_result') throw new Error('Missing tool result');
        expect(result.contentBlocks).toEqual(blocks);
        expect(result.contentBlocks).not.toBe(blocks);
        expect(result.isError ?? false).toBe(!ok);
    });
});

describe('independent read preflight', () => {
    it('returns an invalid read receipt while authorizing and executing valid reads in order', async () => {
        const tools = runtime(); tools.effectFor = () => 'read';
        const input = calls(); input[0].args.value = 42;
        const evaluate = vi.fn(async () => ({ kind: 'allow' as const }));
        const events: AgentEvent[] = [];
        const result = await executeToolBatch(input, { tools, policy: { evaluate }, emit: e => { events.push(e); } });
        expect(result.map(r => [r.status, r.dispatched])).toEqual([['runtime_failure', false], ['success', true]]);
        expect(evaluate).toHaveBeenCalledTimes(1);
        expect(tools.call).toHaveBeenCalledTimes(1);
        expect(events.map(e => [e.type, 'callId' in e ? e.callId : null])).toEqual([
            ['tool_end', 'one'], ['tool_start', 'two'], ['tool_end', 'two'],
        ]);
    });
    it.each(['write', undefined] as const)('rejects the whole batch when any effect is %s', async effect => {
        const tools = runtime(); tools.effectFor = name => name === 'read' ? 'read' : effect;
        const input = calls(); input[0].name = 'read'; input[0].args.value = 42;
        const result = await executeToolBatch(input, { tools });
        expect(tools.call).not.toHaveBeenCalled();
        expect(result.map(r => r.status)).toEqual(['runtime_failure', 'skipped']);
    });
    it('does not authorize or execute an invalid rewrite, but retains independent reads', async () => {
        const tools = runtime(); tools.effectFor = () => 'read';
        const result = await executeToolBatch(calls(), { tools, policy: { evaluate: async c =>
            c.callId === 'one' ? { kind: 'rewrite', args: { value: 42 } } : { kind: 'allow' } } });
        expect(result.map(r => r.dispatched)).toEqual([false, true]);
        expect(vi.mocked(tools.call).mock.calls[0][2]?.authorizedArgs).toEqual({ value: 'second' });
    });
    it('still stops after an uncertain dispatched read', async () => {
        const tools = runtime(); tools.effectFor = () => 'read';
        vi.mocked(tools.call).mockResolvedValue({ ok: false, content: 'Lost receipt', errorKind: 'unknown' });
        const result = await executeToolBatchDetailed(calls(), { tools });
        expect(tools.call).toHaveBeenCalledTimes(1);
        expect(result.controlFailure?.kind).toBe('tool_outcome_unknown');
        expect(result.executions.map(r => r.status)).toEqual(['unknown', 'skipped']);
    });
});
