import {describe,it,expect,vi} from 'vitest';
import {AgentLlmNode} from './AgentLlmNode.js';
import type {GraphContext} from '../../../contracts/graph/IGraphEngine.js';
import type {ILLMProvider,TurnRequest} from '../../../contracts/llm.js';
import type {ContextReport} from '../../../contracts/IAgentContextAssembler.js';

describe('agent graph context preparation',()=>{
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
