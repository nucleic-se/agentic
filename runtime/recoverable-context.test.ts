import { expect, it, vi } from 'vitest';
import { composeAgentContext } from './ContextPipeline.js';
import type { Message } from '../contracts/llm.js';

function history(): Message[] {
    return [
        { role: 'user', content: 'Keep the objective', sticky: true },
        { role: 'assistant', content: '', toolCalls: [{ id: 'old', name: 'read', args: { path: 'original' } }] },
        { role: 'tool_result', toolCallId: 'old', toolName: 'read', content: 'original evidence '.repeat(200) },
        { role: 'assistant', content: '', toolCalls: [{ id: 'new', name: 'read', args: { path: 'recent' } }] },
        { role: 'tool_result', toolCallId: 'new', toolName: 'read', content: 'recent evidence '.repeat(200) },
        { role: 'user', content: 'Current state', sticky: true },
    ];
}

it('replaces older recoverable payloads only under pressure, retaining pairs, recent evidence and source history', async () => {
    const messages = history(), original = structuredClone(messages);
    const reference = vi.fn((_message, index) => `read_saved(${index})`);
    const plain = await composeAgentContext({ messages, tokenBudget: 20000 });
    const selected = await composeAgentContext({ messages, tokenBudget: plain.usage.totalTokens - 1 }, { referenceToolResult: reference });
    expect(selected.messages[2].content).toContain('read_saved(2)');
    expect(selected.messages[2].content).toContain('Preview (not the full result)');
    expect(selected.messages[1]).toEqual(original[1]);
    expect(selected.messages[2]).toMatchObject({ role: 'tool_result', toolCallId: 'old', toolName: 'read' });
    expect(selected.messages[4]).toEqual(original[4]);
    expect(selected.messages[0]).toEqual(original[0]);
    expect(selected.usage.totalTokens).toBeLessThan(plain.usage.totalTokens);
    expect(selected.decisions.find(item => item.id === 'messages:1')).toMatchObject({ action: 'compressed', references: [{ messageIndex: 2, reference: 'read_saved(2)', originalCharacters: original[2].content.length }] });
    expect(messages).toEqual(original);
    expect(reference).toHaveBeenCalledOnce();
});

it('does not reference unavailable sources, error results or native media', async () => {
    const messages = history();
    const untouched = await composeAgentContext({ messages, tokenBudget: 20000 }, { referenceToolResult: () => null });
    expect(untouched.messages).toEqual(messages);
    for (const change of [{ isError: true }, { contentBlocks: [{ type: 'text' as const, text: 'media caption' }] }]) {
        const source = history(); Object.assign(source[2], change);
        const reference = vi.fn(() => 'read_saved(2)');
        const full = await composeAgentContext({ messages: source, tokenBudget: 20000 });
        const result = await composeAgentContext({ messages: source, tokenBudget: full.usage.totalTokens - 1 }, { referenceToolResult: reference });
        expect(result.decisions.find(decision => decision.id === 'messages:1')?.action).toBe('dropped');
        expect(result.decisions.every(decision => !decision.references)).toBe(true);
        expect(reference).not.toHaveBeenCalled();
    }
});

it('does not let a later pressure compressor erase a recovery reference', async () => {
    const messages = history();
    const compress = vi.fn((_message: Message) => null);
    const policy = { minRecentGroups: 0, referenceToolResult: (_message: Message, index: number) => `read_saved(${index})` };
    const result = await composeAgentContext({ messages, tokenBudget: 200 }, { ...policy, compressMessage: compress });
    expect(compress).toHaveBeenCalled();
    expect(result.decisions.some(item => item.action === 'dropped')).toBe(true);
    for (const decision of result.decisions.filter(item => item.action !== 'dropped')) {
        for (const reference of decision.references ?? [])
            expect(result.messages.some(message => message.content.includes(reference.reference))).toBe(true);
    }
    expect(compress.mock.calls.every(([message]) => !message.content.includes('[Earlier tool result;'))).toBe(true);
});


it('keeps fitting evidence intact without invoking retention callbacks', async () => {
    const messages = history(), reference = vi.fn(() => 'read_saved(2)');
    const result = await composeAgentContext({ messages, tokenBudget: 20000 }, { referenceToolResult: reference });
    expect(result.messages).toEqual(messages);
    expect(result.decisions.every(decision => decision.action === 'kept' && !decision.references)).toBe(true);
    expect(reference).not.toHaveBeenCalled();
});

it('references lower-priority evidence first and stops once the context fits', async () => {
    const messages = history();
    const full = await composeAgentContext({ messages, tokenBudget: 20000 });
    const reference = vi.fn((_message, index) => `read_saved(${index})`);
    const result = await composeAgentContext({ messages, tokenBudget: full.usage.totalTokens - 1 }, {
        minRecentGroups: 0, scoreGroup: group => group.some(message => message.role === 'tool_result' && message.toolCallId === 'old') ? 10 : 0,
        referenceToolResult: reference,
    });
    expect(result.messages[2]).toEqual(messages[2]);
    expect(result.messages[4].content).toContain('read_saved(4)');
    expect(reference).toHaveBeenCalledOnce();
    expect(result.decisions.find(decision => decision.id === 'messages:3')).toMatchObject({ score: 0, action: 'compressed' });
    expect(result.usage.totalTokens).toBeLessThanOrEqual(full.usage.totalTokens - 1);
});


it('stops within a multi-result group without disturbing the remaining result or tool pairs', async () => {
    const messages: Message[] = [
        { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read', args: {} }, { id: 'b', name: 'read', args: {} }] },
        { role: 'tool_result', toolCallId: 'a', toolName: 'read', content: 'alpha '.repeat(500) },
        { role: 'tool_result', toolCallId: 'b', toolName: 'read', content: 'beta '.repeat(500) },
    ];
    const full = await composeAgentContext({ messages, tokenBudget: 20000 });
    const reference = vi.fn((_message, index) => `read_saved(${index})`);
    const result = await composeAgentContext({ messages, tokenBudget: full.usage.totalTokens - 1 }, { minRecentGroups: 0, referenceToolResult: reference });
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]).toEqual(messages[0]);
    expect(result.messages[1].content).toContain('read_saved(1)');
    expect(result.messages[2]).toEqual(messages[2]);
    expect(reference).toHaveBeenCalledOnce();
});
