import { expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ILLMProvider, Message, TurnRequest } from '../../contracts/llm.js';
import { chatReply } from './chat.js';
import { reviewProject } from './coding.js';

it('embeds chat with caller-owned history and a borrowed provider', async () => {
    const history: Message[] = [{ role: 'user', content: 'What is two plus two?' }];
    const close = vi.fn();
    const requests: TurnRequest[] = [];
    const provider = {
        structured: async () => { throw new Error('Unexpected structured request'); },
        async turn(request: TurnRequest) {
            requests.push(structuredClone(request));
            request.messages[0].content = 'Provider-local mutation';
            return {
                message: { role: 'assistant' as const, content: 'Four.' },
                stopReason: 'end_turn' as const,
                usage: { inputTokens: 10, outputTokens: 2 },
            };
        },
        close,
    } satisfies ILLMProvider & { close(): void };

    const reply = await chatReply(provider, history);
    expect(reply.message.content).toBe('Four.');
    expect(requests[0].system).toContain('Answer the user clearly.');
    expect(requests[0].maxTokens).toBe(1000);
    expect(history).toEqual([{ role: 'user', content: 'What is two plus two?' }]);
    expect(close).not.toHaveBeenCalled();

    const cancelled = new AbortController();
    cancelled.abort(new Error('Caller cancelled'));
    await expect(chatReply(provider, history, cancelled.signal)).rejects.toThrow('Caller cancelled');
    expect(requests).toHaveLength(1);
});

it('embeds the coding preset with an application provider and preserves tool evidence', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agentic-embedding-'));
    const requests: TurnRequest[] = [];
    const close = vi.fn();
    const provider = {
        configurationIdentity: 'embedding-fixture-v1',
        structured: async () => { throw new Error('Unexpected structured request'); },
        async turn(request: TurnRequest) {
            requests.push(structuredClone(request));
            return {
                message: requests.length === 1
                    ? { role: 'assistant' as const, content: '', toolCalls: [{ id: 'read-entry', name: 'fs_read', args: { path: 'entry.ts' } }] }
                    : { role: 'assistant' as const, content: 'The entry point exports the answer.' },
                stopReason: requests.length === 1 ? 'tool_use' as const : 'end_turn' as const,
                usage: { inputTokens: 20, outputTokens: 10 },
            };
        },
        close,
    } satisfies ILLMProvider & { close(): void };
    try {
        await writeFile(join(workspace, 'entry.ts'), 'export const answer = 42;\n');
        const result = await reviewProject(provider, workspace, 'Explain entry.ts');
        expect(requests).toHaveLength(2);
        expect(requests[0].tools?.map(tool => tool.name)).toContain('fs_read');
        expect(requests[0].tools?.map(tool => tool.name)).not.toContain('fs_write');
        const receipt = requests[1].messages.find(message => message.role === 'tool_result');
        expect(receipt?.content).toContain('export const answer = 42;');
        expect(result.messages).toContainEqual(expect.objectContaining({ role: 'tool_result', toolCallId: 'read-entry' }));
        expect(result.operations).toContainEqual(expect.objectContaining({ kind: 'tool', callId: 'read-entry', status: 'completed', dispatched: true }));
        expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 20 });
        expect(close).not.toHaveBeenCalled();
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});
