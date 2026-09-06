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

it('replaces older recoverable payloads before pressure, retaining pairs, recent evidence and source history', async () => {
    const messages = history(), original = structuredClone(messages);
    const reference = vi.fn((_message, index) => `read_saved(${index})`);
    const plain = await composeAgentContext({ messages, tokenBudget: 20000 });
    const selected = await composeAgentContext({ messages, tokenBudget: 20000 }, { referenceToolResult: reference });
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
        const result = await composeAgentContext({ messages: source, tokenBudget: 20000 }, { referenceToolResult: reference });
        expect(result.messages).toEqual(source);
        expect(reference).not.toHaveBeenCalled();
    }
});

it('does not let a later pressure compressor erase a recovery reference', async () => {
    const messages = history();
    const compress = vi.fn((_message: Message) => null);
    const policy = { minRecentGroups: 0, referenceToolResult: (_message: Message, index: number) => `read_saved(${index})` };
    const roomy = await composeAgentContext({ messages, tokenBudget: 20000 }, policy);
    const result = await composeAgentContext({ messages, tokenBudget: roomy.usage.totalTokens - 1 }, { ...policy, compressMessage: compress });
    expect(compress).toHaveBeenCalled();
    expect(result.decisions.some(item => item.action === 'dropped')).toBe(true);
    for (const decision of result.decisions.filter(item => item.action !== 'dropped')) {
        for (const reference of decision.references ?? [])
            expect(result.messages.some(message => message.content.includes(reference.reference))).toBe(true);
    }
    expect(compress.mock.calls.every(([message]) => !message.content.includes('[Earlier tool result;'))).toBe(true);
});
