import {describe,it,expect,vi} from 'vitest';
import {AgentLlmNode} from './AgentLlmNode.js';
import type {GraphContext} from '../../../contracts/graph/IGraphEngine.js';
import type {ILLMProvider,TurnRequest} from '../../../contracts/llm.js';
import type {ContextReport} from '../../../contracts/IAgentContextAssembler.js';
import { estimateContextTokens } from '../../ContextPipeline.js';

describe('agent graph context preparation',()=>{
    it.each(['reporting callback', 'awaited compression'])('dispatches the accounted tool snapshot despite mutation during %s', async phase => {
        const tools = [{ name: 'read', description: 'small', parameters: { type: 'object' } }];
        const original = structuredClone(tools);
        let report: ContextReport | undefined;
        let release!: () => void;
        let entered!: () => void;
        const compressing = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        const turn = vi.fn(async (_request: TurnRequest) => ({ message: { role: 'assistant' as const, content: 'ok' }, stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } }));
        const state = { system: 'rules', messages: [{ role: 'user' as const, content: 'question' }], answer: undefined as unknown };
        const node = new AgentLlmNode<typeof state>({
            id: 'agent', provider: { turn, structured: vi.fn() }, tools,
            systemPromptKey: 'system', messagesKey: 'messages', outputKey: 'answer',
            contextTokenBudget: 100, maxTokens: 5,
            capabilities: [{ id: 'memory', prompt: { id: 'memory', contribute: () => [{ id: 'optional', priority: 0, text: () => 'x'.repeat(1000) }] } }],
            contextOptions: { compressSection: async () => {
                if (phase === 'awaited compression') { entered(); await gate; }
                return 'fact';
            } },
            onContextPrepared: value => {
                report = structuredClone(value);
                if (phase === 'reporting callback') tools[0].description = 'huge '.repeat(10000);
                value.usage.totalTokens = 0;
                value.decisions.length = 0;
            },
        });
        const running = node.process(state, { signal: new AbortController().signal, reportTokens: vi.fn() } as unknown as GraphContext<typeof state>);
        if (phase === 'awaited compression') {
            await compressing;
            tools[0].description = 'huge '.repeat(10000);
            release();
        }
        await running;
        const submitted = turn.mock.calls[0][0];
        expect(submitted.tools).toEqual(original);
        expect(estimateContextTokens({ ...submitted, reservedOutputTokens: submitted.maxTokens })).toEqual(report?.usage);
        expect(report?.usage.totalTokens).toBeLessThanOrEqual(100);
    });
    it('budgets capability sections before dispatch and reports their selection',async()=>{
        const turn=vi.fn(async(_request:TurnRequest)=>({message:{role:'assistant' as const,content:'ok'},stopReason:'end_turn' as const,usage:{inputTokens:1,outputTokens:1}}));
        const provider={turn,structured:vi.fn(),embed:vi.fn()} as ILLMProvider;
        const state={system:'rules',messages:[{role:'user' as const,content:'question'}],answer:undefined as unknown};
        let report:ContextReport|undefined;
        const node=new AgentLlmNode<typeof state>({id:'agent',provider,systemPromptKey:'system',messagesKey:'messages',outputKey:'answer',contextTokenBudget:40,maxTokens:5,onContextPrepared:r=>{report=r;},capabilities:[{id:'memory',prompt:{id:'memory',contribute:()=>[
            {id:'optional',text:()=> 'x'.repeat(1000),priority:0},
            {id:'fact',text:()=> 'fact',priority:100,provenance:'deterministic'},
        ]}}]});
        await node.process(state,{signal:new AbortController().signal,reportTokens:vi.fn()} as unknown as GraphContext<typeof state>);
        expect(turn).toHaveBeenCalledWith(expect.objectContaining({system:'rules\n\nfact',maxTokens:5}),expect.anything());
        expect(report?.decisions.find(x=>x.id==='optional')?.action).toBe('dropped');
        expect(report?.usage.totalTokens).toBeLessThanOrEqual(40);
        expect(turn.mock.calls[0][0]).not.toHaveProperty('report');
    });
});
