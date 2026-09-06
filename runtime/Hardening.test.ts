import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ToolRuntimeAdapter } from '../tools/adapter.js';
import { FsToolRuntime } from '../tools/fs.js';
import { FetchToolRuntime } from '../tools/fetch.js';
import { boundedFetch } from '../tools/bounded-fetch.js';
import { StateGraphBuilder } from './graph/StateGraphBuilder.js';
import { LlmGraphNode } from './graph/nodes/LlmGraphNode.js';
import { AgentLlmNode } from './graph/nodes/AgentLlmNode.js';
import { BudgetHintCapability } from './capabilities/budget-hint.js';
import { runAgentKernel } from './AgentKernel.js';
import { END, GraphRunLimitError } from '../contracts/graph/index.js';
import { LLMProtocolError, type ILLMProvider, type Message, type TurnResponse } from '../contracts/llm.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import { CodexSubscriptionProvider } from '../providers/codex-subscription.js';
import type { IValidatedToolRuntime } from '../contracts/tool-runtime.js';

const usage = { inputTokens: 100, outputTokens: 100 };
const answer: TurnResponse = { message: { role: 'assistant', content: 'done' }, stopReason: 'end_turn', usage };
const toolResponse: TurnResponse = { message: { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'write', args: { path: 'safe' } }] }, stopReason: 'tool_use', usage };
const provider = (): ILLMProvider => ({ turn: vi.fn(async () => answer), structured: vi.fn(async () => ({ value: {} as any, usage })), embed: async () => [] });
const tools = (): IValidatedToolRuntime => ({ tools: () => [], validate: (_n, args) => ({ ok: true, args }), call: vi.fn(async () => ({ ok: true, content: 'ok' })) });
const temporary: string[] = [];
function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-hardening-')); temporary.push(dir);
    const root = path.join(dir, 'root');
    return { dir, root, runtime: new FsToolRuntime(root) };
}
function sse(events: unknown[]) { return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')); }
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('filesystem boundaries and patch atomicity', () => {
    it('rejects reads and writes through symlinked directories and dangling links', async () => {
        const { dir, root, runtime } = fixture();
        const outside = path.join(dir, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'file'), 'original');
        fs.symlinkSync(outside, path.join(root, 'link'));
        for (const name of ['fs_read', 'fs_write', 'fs_patch', 'fs_delete']) {
            expect((await runtime.call(name, { path: 'link/file', content: 'changed', patches: [{ search: 'original', replace: 'changed' }] })).ok).toBe(false);
        }
        fs.symlinkSync(path.join(outside, 'new'), path.join(root, 'dangling'));
        expect((await runtime.call('fs_write', { path: 'dangling', content: 'changed' })).ok).toBe(false);
        expect(fs.readFileSync(path.join(outside, 'file'), 'utf8')).toBe('original');
        expect(fs.existsSync(path.join(outside, 'new'))).toBe(false);
    });
    it('blocks protected directory deletion, moves, and root removal', async () => {
        const { root, runtime } = fixture(); fs.mkdirSync(path.join(root, 'agents/a'), { recursive: true }); fs.writeFileSync(path.join(root, 'agents/a/state.md'), 'state');
        for (const target of ['.', 'agents', 'agents/a', 'agents/a/state.md']) expect((await runtime.call('fs_delete', { path: target })).ok).toBe(false);
        expect((await runtime.call('fs_move', { from: 'agents/a', to: 'other' })).ok).toBe(false);
        fs.mkdirSync(path.join(root, 'other'));
        expect((await runtime.call('fs_move', { from: 'other', to: 'agents/b' })).ok).toBe(false);
        expect(fs.readFileSync(path.join(root, 'agents/a/state.md'), 'utf8')).toBe('state');
    });
    it('treats replacement dollar sequences literally', async () => {
        const { root, runtime } = fixture(); fs.writeFileSync(path.join(root, 'file'), 'abc');
        expect((await runtime.call('fs_patch', { path: 'file', patches: [{ search: 'b', replace: '$& $$ $`' }] })).ok).toBe(true);
        expect(fs.readFileSync(path.join(root, 'file'), 'utf8')).toBe('a$& $$ $`c');
    });
    it('does not write partial patches when a later operation becomes invalid', async () => {
        const { root, runtime } = fixture(); fs.writeFileSync(path.join(root, 'file'), 'abc');
        expect((await runtime.call('fs_patch', { path: 'file', patches: [{ search: 'ab', replace: 'X' }, { search: 'bc', replace: 'Y' }] })).ok).toBe(false);
        expect(fs.readFileSync(path.join(root, 'file'), 'utf8')).toBe('abc');
    });
});

describe('provider completion boundaries', () => {
    it('rejects OpenAI EOF after an otherwise valid tool delta', async () => {
        vi.stubGlobal('fetch', async () => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'write', arguments: '{}' } }] } }] }]));
        await expect(new OpenAICompatibleProvider({ model: 'mock', baseUrl: 'http://unused' }).streamTurn({ messages: [] }, () => {})).rejects.toBeInstanceOf(LLMProtocolError);
    });
    it.each(['error', 'eof', 'malformed'])('rejects Anthropic %s rather than returning partial text', async mode => {
        vi.stubGlobal('fetch', async () => mode === 'malformed' ? new Response('data: {broken}\n\n') : sse([
            { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
            ...(mode === 'error' ? [{ type: 'error', error: { message: 'overloaded' } }] : []),
        ]));
        await expect(new AnthropicProvider({ apiKey: 'mock', model: 'mock', minRequestSpacingMs: 0 }).streamTurn({ messages: [] }, () => {})).rejects.toBeInstanceOf(LLMProtocolError);
    });
    it('preserves Codex max-token status and prevents kernel tool execution', async () => {
        const codex = new CodexSubscriptionProvider({ model: 'mock', transport: { request: async () => sse([
            { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c', name: 'write', arguments: '{}' } },
            { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } },
        ]) } });
        const runtime = tools();
        const records = await runAgentKernel([], { provider: codex, tools: runtime }, () => ({ messages: [] }));
        expect(records[0].failure?.kind).toBe('max_tokens_stop'); expect(runtime.call).not.toHaveBeenCalled();
    });
    it('keeps truncated malformed tool arguments non-executable', async () => {
        vi.stubGlobal('fetch', async () => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'write', arguments: '{' } }] }, finish_reason: 'length' }] }]));
        const result = await new OpenAICompatibleProvider({ model: 'mock', baseUrl: 'http://unused' }).streamTurn({ messages: [] }, () => {});
        expect(result.stopReason).toBe('max_tokens'); expect(result.message.toolCalls).toBeUndefined();
    });
    it('rejects duplicate Codex call IDs', async () => {
        const item = { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c', name: 'write', arguments: '{}' } };
        const codex = new CodexSubscriptionProvider({ model: 'mock', transport: { request: async () => sse([item, item, { type: 'response.completed', response: { status: 'completed' } }]) } });
        await expect(codex.turn({ messages: [] })).rejects.toBeInstanceOf(LLMProtocolError);
    });
    it('cancels a reader when a consumer throws', async () => {
        const cancel = vi.fn();
        vi.stubGlobal('fetch', async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"text"}}]}\n\n')); }, cancel })));
        await expect(new OpenAICompatibleProvider({ model: 'mock', baseUrl: 'http://unused' }).streamTurn({ messages: [] }, () => { throw new Error('consumer failed'); })).rejects.toThrow('consumer failed');
        expect(cancel).toHaveBeenCalledOnce();
    });
});

describe('kernel authorization and records', () => {
    it('confirms transformed arguments and isolates stored requests', async () => {
        const llm = provider(); llm.turn = vi.fn().mockResolvedValueOnce(toolResponse).mockResolvedValueOnce(answer);
        const runtime = tools(); const confirm = vi.fn(() => true);
        const conversation: Message[] = [{ role: 'user', content: 'go' }];
        const records = await runAgentKernel(conversation, { provider: llm, tools: runtime, policy: { evaluate: async () => ({ kind: 'confirm', reason: 'test' }) }, confirmToolCall: confirm, beforeToolCall: () => ({ action: 'continue', args: { path: 'final' } }) }, () => ({ messages: conversation }));
        expect(confirm.mock.calls[0][0].args).toEqual({ path: 'final' });
        expect(vi.mocked(runtime.call).mock.calls[0][1]).toEqual({ path: 'final' });
        expect(records[0].modelRequest.messages).toEqual([{ role: 'user', content: 'go' }]);
        conversation[0].content = 'mutated'; expect(records[0].modelRequest.messages[0].content).toBe('go');
    });
    it('fails closed when validation changes already-confirmed arguments', async () => {
        const llm = provider(); llm.turn = async () => toolResponse;
        const runtime = tools(); let validations = 0;
        runtime.validate = (_n, args) => ({ ok: true, args: ++validations >= 4 ? { path: 'changed' } : args });
        const confirm = vi.fn(() => true);
        await runAgentKernel([], { provider: llm, tools: runtime, maxTurns: 1, policy: { evaluate: async () => ({ kind: 'confirm', reason: 'test' }) }, confirmToolCall: confirm }, () => ({ messages: [] }));
        expect(confirm.mock.calls[0][0].args).toEqual({ path: 'safe' });
        expect(runtime.call).not.toHaveBeenCalled();
    });
    it('adapter refuses execution if its own validation changes authorized input', async () => {
        const execute = vi.fn();
        const runtime = new ToolRuntimeAdapter([{ name: 'write', description: '', input: { jsonSchema: { type: 'object' }, validate: () => ({ ok: true, value: { path: 'changed' } }) }, execute }]);
        expect((await runtime.call('write', { path: 'safe' }, { authorizedArgs: { path: 'safe' } })).ok).toBe(false);
        expect(execute).not.toHaveBeenCalled();
    });
    it('rejects invalid hook transformations before confirmation', async () => {
        const llm = provider(); llm.turn = async () => toolResponse;
        const runtime = tools(); runtime.validate = (_n, args) => args.path === 'bad' ? { ok: false, result: { ok: false, content: 'bad input' } } : { ok: true, args };
        const confirm = vi.fn(() => true);
        await runAgentKernel([], { provider: llm, tools: runtime, maxTurns: 1, policy: { evaluate: async () => ({ kind: 'confirm', reason: 'test' }) }, confirmToolCall: confirm, beforeToolCall: () => ({ action: 'continue', args: { path: 'bad' } }) }, () => ({ messages: [] }));
        expect(confirm).not.toHaveBeenCalled(); expect(runtime.call).not.toHaveBeenCalled();
    });
});

describe('graph budgets and capability persistence', () => {
    it.each([false, true])('counts LlmGraphNode usage (structured=%s)', async structured => {
        const llm = provider();
        const builder = new StateGraphBuilder();
        for (const id of ['a', 'b']) builder.addNode(new LlmGraphNode({ id, provider: llm, prompt: () => ({ instructions: '', text: 'go' }), outputKey: 'out', ...(structured ? { schema: { type: 'object' } } : {}) }));
        const engine = builder.setEntry('a').addEdge('a', 'b').build({ limits: { maxTotalTokens: 1 } });
        await expect(engine.run({ out: '' })).rejects.toBeInstanceOf(GraphRunLimitError);
        expect(structured ? llm.structured : llm.turn).toHaveBeenCalledOnce();
    });
    it('interrupts a never-resolving final node at the run deadline', async () => {
        vi.useFakeTimers(); let signal: AbortSignal | undefined;
        const engine = new StateGraphBuilder().addNode({ id: 'slow', process: async (_s, c) => { signal = c.signal; await new Promise(() => {}); } }).setEntry('slow').build({ limits: { maxTotalMs: 5 } });
        const result = expect(engine.run({})).rejects.toBeInstanceOf(GraphRunLimitError);
        await vi.advanceTimersByTimeAsync(6); await result; expect(signal?.aborted).toBe(true);
    });
    it('keeps simultaneous run token counters independent', async () => {
        const engine = new StateGraphBuilder().addNode({ id: 'a', process: async (_s, c) => { c.reportTokens(1); await new Promise(r => setTimeout(r, 1)); } }).addNode({ id: 'b', process: async () => {} }).setEntry('a').addEdge('a', 'b').build({ limits: { maxTotalTokens: 2 } });
        const result = await Promise.all([engine.run({}), engine.run({})]); expect(result.map(r => r.steps)).toEqual([2, 2]);
    });
    it('emits each budget threshold only once through graph state cloning', async () => {
        const cap = new BudgetHintCapability({ maxTurns: 4, turnCountKey: 'turns', messagesKey: 'messages', thresholds: [{ pct: 0.5, message: 'wrap up' }] });
        const engine = new StateGraphBuilder().addNode(new AgentLlmNode({ id: 'llm', provider: provider(), systemPromptKey: 'system', messagesKey: 'messages', outputKey: 'out', capabilities: [cap] })).setEntry('llm').addConditionalEdge('llm', s => Number(s.turns) >= 3 ? END : 'llm').build();
        const result = await engine.run({ turns: 0, system: '', messages: [], out: null });
        expect(result.state.messages).toEqual([{ role: 'user', content: 'wrap up', sticky: true }]);
    });
});

describe('HTTP body bounds', () => {
    it('keeps the deadline alive after headers arrive', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => new Response(new ReadableStream({ start(c) { init.signal!.addEventListener('abort', () => c.error(init.signal!.reason)); } })));
        const result = new FetchToolRuntime().call('fetch_get', { url: 'http://unused' });
        await vi.advanceTimersByTimeAsync(15_001);
        expect((await result).ok).toBe(false);
    });
    it('cancels an oversized body without consuming the remaining stream', async () => {
        const cancel = vi.fn();
        vi.stubGlobal('fetch', async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1024)); }, cancel })));
        const result = await boundedFetch('http://unused', {}, 32);
        expect(Buffer.byteLength(result.text)).toBeLessThan(64); expect(result.text).toContain('[truncated]'); expect(cancel).toHaveBeenCalledOnce();
    });
});
