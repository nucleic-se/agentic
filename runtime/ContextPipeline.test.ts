import { describe, expect, it, vi } from 'vitest';
import { AgentContextAssembler } from './AgentContextAssembler.js';
import { collectPromptSections, composeAgentContext, compressToolResult, ContextBudgetExceededError, ContextCompressionError, estimateContextTokens } from './ContextPipeline.js';
import { composePromptSections } from './PromptEngine.js';
import { collectContextSections } from './ContextAssembler.js';
import type { PromptSection } from '../contracts/IPromptEngine.js';
import type { Message, ToolDefinition } from '../contracts/llm.js';
import type { ITokenCounter } from '../contracts/ITokenCounter.js';

const section = (id: string, text: string, priority = 1, extra: Partial<PromptSection> = {}): PromptSection => ({
    id, priority, weight: 1, estimatedTokens: 1, tags: [], text: () => text, ...extra,
});
const counter: ITokenCounter = {
    countTokens: text => text.length,
    countTokensForMessages: messages => messages.reduce((sum, message) => sum + 2 + (typeof message.content === 'string'
        ? message.content.length : (message.content as { text: string }[]).reduce((total, block) => total + block.text.length, 0)), 0),
};
const tools: ToolDefinition[] = [{ name: 'inspect', description: 'Inspect a workspace', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];

describe('composable context primitives', () => {
    it('keeps section collection separate from selection and never forces an oversized first section', () => {
        const supplied = section('supplied', 'supplied');
        const toolSection = section('tool', 'rendered tool data');
        const renderer = { render: vi.fn(() => [toolSection]) };
        expect(collectContextSections({ contributorSections: [supplied], toolResults: [] }, renderer)).toEqual([supplied]);
        const oversized = section('oversized', 'x'.repeat(400), 1, { estimatedTokens: 1 });
        expect(composePromptSections([oversized], 10)).toMatchObject({ text: '', included: [], excluded: [expect.objectContaining({id: 'oversized'})], totalTokens: 0 });
    });
    it('collects existing contributors, selects by priority and renders snapshots with attribution', async () => {
        const render = vi.fn(() => 'trusted constraint');
        const sections = await collectPromptSections([
            { id: 'rules', contribute: () => [section('rules', '', 0, { phase: 'constraint', provenance: 'human', text: render })] },
            { id: 'retrieval', contribute: async () => [section('discard', 'x'.repeat(200), 1), section('fact', 'useful fact', 100, { phase: 'memory', provenance: 'deterministic' })] },
        ], { userInput: 'task' });
        const result = await composeAgentContext({ sections, messages: [], tokenBudget: 50 }, { tokenCounter: counter });
        expect(result.system).toBe('trusted constraint\n\nuseful fact');
        expect(result.includedSections.map(item => [item.id, item.provenance])).toEqual([['rules', 'human'], ['fact', 'deterministic']]);
        expect(result.excludedSections.map(item => item.id)).toEqual(['discard']);
        expect(result.usage.systemTokens).toBe(result.system.length + 2);
        expect(render).toHaveBeenCalledTimes(1);
        expect(composePromptSections(result.includedSections, 1000).text).toBe(result.system);
    });

    it('charges system wrappers, tool schemas, and reserved output before selecting any history', async () => {
        const input = { system: 'rules', messages: [{ role: 'user' as const, content: 'request' }], tools, reservedOutputTokens: 20 };
        const estimated = estimateContextTokens(input, { tokenCounter: counter });
        expect(estimated.systemTokens).toBe(7);
        expect(estimated.messageTokens).toBe(9);
        expect(estimated.toolTokens).toBe(JSON.stringify({ tools }).length);
        expect(estimated.totalTokens).toBe(7 + 9 + estimated.toolTokens + 20);
        await expect(composeAgentContext({ ...input, tokenBudget: estimated.totalTokens - 1 }, { tokenCounter: counter }))
            .rejects.toBeInstanceOf(ContextBudgetExceededError);
        const context = await composeAgentContext({ ...input, tokenBudget: estimated.totalTokens }, { tokenCounter: counter });
        expect(context.messages).toEqual(input.messages);
        expect(context.usage.totalTokens).toBe(estimated.totalTokens);
        await expect(composeAgentContext({ messages: [], tools, reservedOutputTokens: 1000, tokenBudget: 100 }))
            .rejects.toBeInstanceOf(ContextBudgetExceededError);
    });

    it('lets final-request instructions override configuration without hiding their cost', async () => {
        const assembler = new AgentContextAssembler({ systemPrompt: 'irrelevant long configured instructions', tokenBudget: 15, tokenCounter: counter });
        const input = { userInput: '', messages: [], tokenBudget: 15, system: 'short', reservedOutputTokens: 8 };
        await expect(assembler.assemble(input)).resolves.toMatchObject({ system: 'short', messages: [], report: { usage: { totalTokens: 15 } } });
        await expect(assembler.assemble({ ...input, reservedOutputTokens: 9 })).rejects.toBeInstanceOf(ContextBudgetExceededError);
    });

    it('compresses a lower-priority section before dropping it, preserving its metadata', async () => {
        const input = section('memory', 'x'.repeat(1000), 1, { phase: 'memory', provenance: 'model', tags: ['summary'] });
        const compressed = await composeAgentContext({ sections: [input], messages: [], tokenBudget: 20 }, {
            tokenCounter: counter, compressSection: () => 'short summary',
        });
        expect(compressed.system).toBe('short summary');
        expect(compressed.includedSections[0]).toMatchObject({ id: 'memory', phase: 'memory', provenance: 'model', tags: ['summary'] });
        expect(compressed.decisions[0].action).toBe('compressed');
        expect(input.text()).toHaveLength(1000);
    });

    it('protects constraint sections and sticky/recent messages from compression as well as dropping', async () => {
        const compressSection = vi.fn(() => ''), compressMessage = vi.fn(() => null);
        await expect(composeAgentContext({ sections: [section('rules', 'x'.repeat(1000), 0, { phase: 'constraint' }), section('optional', 'y'.repeat(1000))],
            messages: [{ role: 'user', content: 'keep', sticky: true }], tokenBudget: 30 }, { compressSection, compressMessage }))
            .rejects.toBeInstanceOf(ContextBudgetExceededError);
        expect(compressSection).not.toHaveBeenCalled();
        expect(compressMessage).not.toHaveBeenCalled();
    });

    it('preserves dependency intervals even when tool results are interleaved with other messages', async () => {
        const messages: Message[] = [
            { role: 'assistant', content: '', toolCalls: [{ id: 'call', name: 'inspect', args: {} }] },
            { role: 'user', content: 'interleaved input' },
            { role: 'tool_result', toolCallId: 'call', content: 'large'.repeat(100) },
            { role: 'user', content: 'latest' },
        ];
        const result = await composeAgentContext({ messages, tokenBudget: 20 }, { minRecentGroups: 1 });
        expect(result.messages).toEqual([messages[3]]);
        expect(result.decisions.filter(item => item.kind === 'messages')).toHaveLength(2);
    });

    it('accepts partial provider continuation without inventing or dropping missing partners', async () => {
        const continuation: Message[] = [{ role: 'tool_result', toolCallId: 'previous-request-call', content: 'result' }];
        const result = await composeAgentContext({ messages: continuation, tokenBudget: 100 }, { minRecentGroups: 0 });
        expect(result.messages).toEqual(continuation);
        await expect(composeAgentContext({ messages: continuation, tokenBudget: 1 }, { minRecentGroups: 0 }))
            .rejects.toBeInstanceOf(ContextBudgetExceededError);
        const planned: Message[] = [{ role: 'assistant', content: '', toolCalls: [{ id: 'pending', name: 'tool', args: {} }] }];
        await expect(composeAgentContext({ messages: planned, tokenBudget: 100 })).resolves.toMatchObject({ messages: planned });
    });

    it.each(['provenance', 'toolCallId', 'media'] as const)('rejects compressors that alter %s without mutating source history', async field => {
        const messages: Message[] = [
            { role: 'assistant', content: '', toolCalls: [{ id: 'call', name: 'inspect', args: {} }] },
            { role: 'tool_result', toolCallId: 'call', content: 'large '.repeat(1000), provenance: 'deterministic',
                contentBlocks: [{ type: 'text', text: 'large '.repeat(1000) }, { type: 'image', data: 'image', mimeType: 'image/png' }] },
            { role: 'user', content: 'next' },
        ];
        const original = structuredClone(messages);
        await expect(composeAgentContext({ messages, tokenBudget: 100 }, { minRecentGroups: 1,
            compressMessage(message) {
                if (message.role !== 'tool_result') return null;
                if (field === 'provenance') message.provenance = 'human';
                if (field === 'toolCallId') message.toolCallId = 'changed';
                if (field === 'media') message.contentBlocks = [];
                return message;
            },
        })).rejects.toBeInstanceOf(ContextCompressionError);
        expect(messages).toEqual(original);
    });

    it('preserves image order while compressing surrounding rich text', () => {
        const first = { type: 'image' as const, data: 'first', mimeType: 'image/png' };
        const second = { type: 'image' as const, data: 'second', mimeType: 'image/png' };
        const message: Message = { role: 'tool_result', toolCallId: 'x', content: 'fallback', provenance: 'deterministic',
            contentBlocks: [first, { type: 'text', text: 'x'.repeat(3000) }, second, { type: 'text', text: 'more'.repeat(3000) }] };
        const result = compressToolResult(message);
        if (result?.role !== 'tool_result') throw new Error('Expected a tool result');
        expect(result.contentBlocks?.map(block => block.type)).toEqual(['image', 'text', 'image', 'text']);
        expect(result.contentBlocks?.filter(block => block.type === 'image')).toEqual([first, second]);
        expect(result.provenance).toBe('deterministic');
    });

    it('rejects duplicate sections and non-finite counters and respects cancellation', async () => {
        await expect(composeAgentContext({ messages: [], sections: [section('same', 'one'), section('same', 'two')], tokenBudget: 100 }))
            .rejects.toThrow('Duplicate prompt section');
        await expect(collectPromptSections([{ id: 'same', contribute: () => [] }, { id: 'same', contribute: () => [] }], {}))
            .rejects.toThrow('Duplicate prompt contributor');
        await expect(composeAgentContext({ system: 'system', messages: [], tokenBudget: 100 }, {
            tokenCounter: { countTokens: () => NaN, countTokensForMessages: () => NaN },
        })).rejects.toThrow('Token counter');
        const controller = new AbortController();
        controller.abort();
        await expect(composeAgentContext({ messages: [], tokenBudget: 100, signal: controller.signal })).rejects.toThrow();
    });
});

describe('shared section policy', () => {
    it('makes selection independent of phase and agrees across entry points', async () => {
        const sections = [section('early-low', 'abcdefghij', 1, {phase:'task'}), section('late-high', 'klmnopqrst', 100, {phase:'memory'})];
        const prompt = composePromptSections(sections, 12, {tokenCounter: counter});
        const context = await composeAgentContext({sections, messages:[], tokenBudget:12}, {tokenCounter:counter});
        expect(prompt.included.map(s=>s.id)).toEqual(['late-high']);
        expect(context.system).toBe(prompt.text);
        expect(context.usage.totalTokens).toBe(prompt.totalTokens);
    });
    it('uses the same required overflow rule and stable identifier ties', async () => {
        const required = section('rules','x'.repeat(30),0,{phase:'constraint'});
        expect(()=>composePromptSections([required],12,{tokenCounter:counter})).toThrow(ContextBudgetExceededError);
        await expect(composeAgentContext({sections:[required],messages:[],tokenBudget:12},{tokenCounter:counter})).rejects.toThrow(ContextBudgetExceededError);
        const sections = [section('z','1234567890',1),section('a','1234567890',1)];
        expect(composePromptSections(sections,12,{tokenCounter:counter}).included.map(s=>s.id)).toEqual(['a']);
        expect((await composeAgentContext({sections,messages:[],tokenBudget:12},{tokenCounter:counter})).includedSections.map(s=>s.id)).toEqual(['a']);
    });
    it('does not let absolute history length outrank a fixed priority fact', async () => {
        for (const length of [2,100]) {
            const context = await composeAgentContext({sections:[section('fact','F',1)], messages:Array.from({length},(_,i)=>({role:'user' as const,content:String(i)})),tokenBudget:15},{tokenCounter:counter,minRecentGroups:0});
            expect(context.includedSections.map(s=>s.id)).toEqual(['fact']);
            expect(context.messages.at(-1)?.content).toBe(String(length-1));
        }
    });
    it('charges structured output schema and output reserve', async () => {
        const responseSchema={type:'object',properties:{answer:{type:'string'}}};
        const context=await composeAgentContext({messages:[],responseSchema,tokenBudget:1000,reservedOutputTokens:20},{tokenCounter:counter});
        expect(context.usage.schemaTokens).toBe(JSON.stringify(responseSchema).length);
        expect(context.usage.totalTokens).toBe(context.usage.schemaTokens+20);
    });
});
