import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { budgetedContext, codingToolRuntime, conversationalLoop, defaultCodingPolicy, planningLoop } from './defaults.js';
import type { LoopServices, SessionClient, SessionRecord, SessionUpdate } from './types.js';
import type { Message, TurnRequest, TurnResponse } from '../../contracts/llm.js';
import { startTerminalUi } from './ui/terminal.js';

it('keeps the coding pack small and rejects excluded effects at dispatch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coding-manifest-'));
    try {
        const runtime = codingToolRuntime(root);
        expect(runtime.tools().map(tool => tool.name).sort()).toEqual([
            'fs_list', 'fs_patch', 'fs_read', 'fs_write', 'read_output', 'search_find', 'search_grep', 'shell_run',
        ]);
        const reads = codingToolRuntime(root, { readOnly: true });
        expect(reads.tools()).toHaveLength(5);
        expect(reads.validate('fs_write', { path: 'unwanted', content: 'changed' }).ok).toBe(false);
        expect((await reads.call('shell_run', { command: 'touch unwanted' })).ok).toBe(false);
        expect((await runtime.call('fs_delete', { path: 'unwanted' })).ok).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

function setup(responses: TurnResponse[]) {
    const messages: Message[] = [{ role: 'user', content: 'Do the task' }];
    const requests: TurnRequest[] = [];
    let batches = 0;
    const services: LoopServices = {
        signal: new AbortController().signal,
        model: { async request(request) {
            requests.push(structuredClone(request));
            const response = responses.shift();
            if (!response) throw new Error('Unexpected model call');
            if (response.stopReason !== 'max_tokens') messages.push(structuredClone(response.message));
            return response;
        } },
        tools: { async executeBatch(calls) {
            batches++;
            messages.push(...calls.map(call => ({ role: 'tool_result' as const, toolCallId: call.id, toolName: call.name, content: 'done', isError: false })));
            return calls.map(call => ({ callId: call.id, plan: { callId: call.id, name: call.name, input: call.args }, status: 'success' as const, result: { ok: true, content: 'done' } }));
        } },
        async context() { return { messages: structuredClone(messages) }; },
        async messages() { return structuredClone(messages); },
        async append(next) { messages.push(...next); },
        async takeQueued() { return []; },
    };
    return { services, messages, requests, batches: () => batches };
}
function response(content: string, tool = false): TurnResponse {
    return { message: { role: 'assistant', content, ...(tool ? { toolCalls: [{ id: 'call-1', name: 'fs_read', args: { path: 'a' } }] } : {}) },
        stopReason: tool ? 'tool_use' : 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
}

describe('default harness strategies', () => {
    it('reserves the configured output cap in both planning and conversation requests', async () => {
        const run = setup([response('Plan'), response('Answer')]);
        await planningLoop({ maxTokens: 128 }).run(run.services);
        expect(run.requests.map(request => request.maxTokens)).toEqual([128, 128]);
        const context = await budgetedContext('system', 1000).assemble(run.requests[0].messages, run.services.signal,
            { tools: run.requests[0].tools, system: run.requests[0].system, reservedOutputTokens: run.requests[0].maxTokens });
        expect(context.report?.usage.reservedOutputTokens).toBe(128);
        expect(() => conversationalLoop({ maxTokens: 0 })).toThrow('maxTokens');
    });
    it('planning makes two model operations before executing tools, with no planning tools', async () => {
        const run = setup([response('Plan: inspect then answer'), response('', true), response('Answer')]);
        await planningLoop().run(run.services);
        expect(run.requests).toHaveLength(3);
        expect(run.requests[0].tools).toEqual([]);
        expect(run.requests[1].messages.at(-1)?.content).toContain('Plan:');
        expect(run.batches()).toBe(1);
        expect(run.messages.filter(message => message.role === 'tool_result')).toEqual([
            { role: 'tool_result', toolCallId: 'call-1', toolName: 'fs_read', content: 'done', isError: false },
        ]);
    });
    it('never dispatches truncated output', async () => {
        const partial = response('', true); partial.stopReason = 'max_tokens';
        const run = setup([partial]);
        await expect(conversationalLoop().run(run.services)).rejects.toThrow('token limit');
        expect(run.batches()).toBe(0);
        expect(run.messages).toHaveLength(1);
    });
    it('enforces loop limits rather than silently returning unfinished work', async () => {
        const run = setup([response('', true)]);
        await expect(conversationalLoop({ maxTurns: 1 }).run(run.services)).rejects.toThrow('turn limit');
    });
    it('does not duplicate messages already projected by queue delivery', async () => {
        const run = setup([response('Answer')]);
        let pending = true;
        run.services.takeQueued = async mode => {
            if (!pending || mode !== 'steer') return [];
            pending = false;
            const delivered: Message[] = [{ role: 'user', content: 'Follow this correction' }];
            run.messages.push(...delivered);
            return delivered;
        };
        await conversationalLoop().run(run.services);
        expect(run.messages.filter(message => message.content === 'Follow this correction')).toHaveLength(1);
        expect(run.messages.filter(message => message.content === 'Answer')).toHaveLength(1);
    });
    it('budget strategy preserves the original transcript', async () => {
        const messages: Message[] = [{ role: 'user', content: 'old '.repeat(2000) }, { role: 'assistant', content: 'old answer' }, { role: 'user', content: 'new task' }];
        const before = structuredClone(messages);
        const assembled = await budgetedContext('system', 500).assemble(messages, new AbortController().signal);
        expect(messages).toEqual(before);
        expect(assembled.messages.length).toBeLessThan(messages.length);
    });
});

describe('default coding runtime', () => {
    it('lets a composition retain a larger complete file page without changing source or cursor semantics', async () => {
        const root = mkdtempSync(join(tmpdir(), 'agentic-page-'));
        try {
            const source = Array.from({ length: 100 }, (_, i) => `line ${i}: ${'x'.repeat(70)}`).join('\n');
            writeFileSync(join(root, 'source.txt'), source);
            const small = await codingToolRuntime(root).call('fs_read', { path: 'source.txt' });
            const large = await codingToolRuntime(root, { textPageBytes: 16000 }).call('fs_read', { path: 'source.txt' });
            expect(small.content).toContain('[truncated; continue with offset:');
            expect(large.ok).toBe(true);
            expect(large.content).toContain('100: line 99:');
            expect(large.content).not.toContain('[truncated;');
            expect(() => codingToolRuntime(root, { textPageBytes: 0 })).toThrow('textPageBytes');
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it('validates executable arguments and preserves native failures', async () => {
        const root = mkdtempSync(join(tmpdir(), 'agentic-default-'));
        try {
            const runtime = codingToolRuntime(root);
            expect(runtime.validate('fs_write', { path: 'x' }).ok).toBe(false);
            expect(runtime.validate('fs_write', { path: '../outside', content: 'x' }).ok).toBe(false);
            const missing = await runtime.call('fs_read', { path: 'missing' });
            expect(missing.ok).toBe(false);
            expect(missing.content).toContain('not found');
            expect((await runtime.call('fs_write', { path: 'x', content: 'hello' })).ok).toBe(true);
            expect((await runtime.call('fs_read', { path: 'x' })).content).toContain('hello');
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
    it('rejects symlink search roots and changed authorized arguments', async () => {
        const root = mkdtempSync(join(tmpdir(), 'agentic-default-'));
        try {
            symlinkSync(tmpdir(), join(root, 'escape'));
            const runtime = codingToolRuntime(root);
            expect(runtime.validate('search_find', { path: 'escape', pattern: '*' }).ok).toBe(false);
            const result = await runtime.call('fs_write', { path: 'x', content: 'changed' }, { authorizedArgs: { path: 'x', content: 'approved' } });
            expect(result.errorKind).toBe('policy');
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
    it('cancels running shell work and bounds captured output', async () => {
        const root = mkdtempSync(join(tmpdir(), 'agentic-default-'));
        try {
            const runtime = codingToolRuntime(root);
            const controller = new AbortController();
            const running = runtime.call('shell_run', { command: 'sleep 30', timeout_ms: 5000 }, { signal: controller.signal });
            setTimeout(() => controller.abort(), 30);
            expect((await running).errorKind).toBe('cancelled');
            writeFileSync(join(root, 'output.cjs'), 'process.stdout.write("a".repeat(100000));');
            const output = await runtime.call('shell_run', { command: `${JSON.stringify(process.execPath)} output.cjs` });
            expect(output.ok).toBe(true);
            expect(output.content.length).toBeLessThan(65700);
            expect(output.content).toContain('read_output');
            expect(output.data).toMatchObject({ totalBytes: 100000, incomplete: false });
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
    it('allows reads and requires confirmation for side effects', async () => {
        const policy = defaultCodingPolicy();
        const context = { callId: '1', args: {}, trustTier: 'standard' as const };
        expect((await policy.evaluate({ ...context, name: 'fs_read' })).kind).toBe('allow');
        expect((await policy.evaluate({ ...context, name: 'shell_run' })).kind).toBe('confirm');
    });
});

describe('terminal UI', () => {
    it('accepts cancellation while submission remains pending and detaches cleanly', async () => {
        const input = new PassThrough(); const output = new PassThrough();
        let listener: ((update: SessionUpdate) => void) | undefined;
        let cancelled = false; let detached = false;
        const session = { id: 'session', title: 'test', messages: [], approvals: [] } as unknown as SessionRecord;
        const client = {
            async create() { return session; }, async get() { return session; },
            submit() { return new Promise<void>(() => {}); },
            async cancel() { cancelled = true; },
            subscribe(next: (update: SessionUpdate) => void) { listener = next; return () => { detached = true; }; },
        } as unknown as SessionClient;
        const close = await startTerminalUi(client, { input, output });
        input.write('hello\n/cancel\n');
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(cancelled).toBe(true);
        expect(listener).toBeDefined();
        close(); expect(detached).toBe(true);
    });
});
