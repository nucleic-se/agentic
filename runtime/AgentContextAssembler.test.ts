import { describe, expect, it } from 'vitest';
import { AgentContextAssembler, ContextBudgetExceededError } from './AgentContextAssembler.js';
import type { Message, ToolResultMessage } from '../contracts/llm.js';

function history(result: ToolResultMessage): Message[] {
    return [
        { role: 'assistant', content: '', toolCalls: [{ id: 'image', name: 'inspect', args: {} }] },
        result,
        { role: 'user', content: 'Continue' },
    ];
}

describe('rich tool context accounting', () => {
    it('charges actual rich text even when fallback content is tiny', async () => {
        const assembler = new AgentContextAssembler({ systemPrompt: '', tokenBudget: 50 });
        const messages = history({ role: 'tool_result', toolCallId: 'image', content: 'fallback',
            contentBlocks: [{ type: 'text', text: 'large '.repeat(1000) }] });
        await expect(assembler.assemble({ messages, userInput: '', tokenBudget: 50 }))
            .rejects.toBeInstanceOf(ContextBudgetExceededError);
    });

    it('compresses the transmitted rich text while preserving image content and source history', async () => {
        const assembler = new AgentContextAssembler({ systemPrompt: '', tokenBudget: 300, minRecentGroups: 1, imageTokenEstimate: 100 });
        const image = { type: 'image' as const, data: 'aW1hZ2U=', mimeType: 'image/png' };
        const messages = history({ role: 'tool_result', toolCallId: 'image', content: 'fallback',
            contentBlocks: [{ type: 'text', text: 'large '.repeat(1000) }, image] });
        const original = structuredClone(messages);
        const context = await assembler.assemble({ messages, userInput: '', tokenBudget: 300 });
        const result = context.messages.find(message => message.role === 'tool_result');
        expect(result).toBeDefined();
        if (result?.role !== 'tool_result') throw new Error('Missing result');
        expect(result.content).toContain('[truncated by context manager]');
        expect(result.contentBlocks).toEqual([{ type: 'text', text: result.content }, image]);
        expect(messages).toEqual(original);
    });

    it('drops the entire old tool group when its retained image exceeds the budget', async () => {
        const assembler = new AgentContextAssembler({ systemPrompt: '', tokenBudget: 200, minRecentGroups: 1 });
        const messages = history({ role: 'tool_result', toolCallId: 'image', content: '',
            contentBlocks: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }] });
        const context = await assembler.assemble({ messages, userInput: '', tokenBudget: 200 });
        expect(context.messages).toEqual([{ role: 'user', content: 'Continue' }]);
    });

    it('uses configurable image estimates instead of tokenizing base64 transport bytes', async () => {
        const assembler = new AgentContextAssembler({ systemPrompt: '', tokenBudget: 200, imageTokenEstimate: 100 });
        const messages = history({ role: 'tool_result', toolCallId: 'image', content: '',
            contentBlocks: [{ type: 'image', data: 'a'.repeat(100000), mimeType: 'image/png' }] });
        const context = await assembler.assemble({ messages, userInput: '', tokenBudget: 200 });
        expect(context.messages).toHaveLength(3);
        expect(() => new AgentContextAssembler({ systemPrompt: '', tokenBudget: 200, imageTokenEstimate: -1 })).toThrow(RangeError);
    });
});
