import { expect, it } from 'vitest';
import { createHarness } from './host.js';
import { MemorySessionStore } from './stores.js';
import { agentContext } from './agent-context.js';
import { conversationalLoop } from './loops.js';
import { LLMContextOverflowError, type TurnResponse } from '../../contracts/llm.js';
const answer = (content: string): TurnResponse => ({message:{role:'assistant',content},stopReason:'end_turn',usage:{inputTokens:10,outputTokens:2}});
for (const mode of ['recover', 'repeat', 'transport', 'maintenance', 'no-prefix', 'no-checkpoint'] as const) it(`handles provider overflow: ${mode}`, async () => {
    let tasks=0, summaries=0, tools=0;
    const store = new MemorySessionStore();
    const client = await createHarness().compose({extensions:[{id:'test',version:'1',apiVersion:1,roles:{
        store:()=>store, context:()=>agentContext('Rules', 16000, {checkpointMaxTokens:128, checkpointing:mode !== 'no-checkpoint'}), loop:()=>conversationalLoop(),
        policy:()=>({evaluate:async()=>({kind:'allow' as const})}),
        tools:()=>({tools:()=>[],validate:(_name,args)=>({ok:true,args}),call:async()=>{tools++;return {ok:true,content:'effect'};}}),
        provider:()=>({structured:async()=>{throw new Error('unused');},turn:async request=>{
            if(request.system?.startsWith('Maintain')){summaries++;if(mode==='maintenance')throw new LLMContextOverflowError();return answer('Prior work verified. Preserve the current requirement.');}
            tasks++;
            if(mode==='transport')throw new Error('network failed');
            if(tasks===1 || mode==='repeat')throw new LLMContextOverflowError();
            expect(request.messages.some(m=>m.content.includes('Prior work verified'))).toBe(true);
            expect(request.messages.at(-1)?.content).toBe('Current requirement');
            return answer('Done');
        }}),
    }}]});
    try {
        const session=await client.create();
        const history = Array.from({length:mode === 'no-prefix' ? 0 : 8},(_,i)=>[{role:'user' as const,content:`Past ${i}: `+'evidence '.repeat(100)},{role:'assistant' as const,content:'Reviewed'}]).flat();
        await client.replaceMessages(session.id,0,history);
        await client.submit(session.id,'Current requirement',{commandId:'input'});
        const record=await client.wait(session.id);
        expect(record.status).toBe(mode==='recover'?'idle':'failed');
        expect(tasks).toBe(mode==='recover'||mode==='repeat'?2:1);
        expect(summaries).toBe(['transport','no-prefix','no-checkpoint'].includes(mode)?0:1);
        expect(tools).toBe(0);
        expect(record.messages.slice(0,history.length)).toEqual(history);
        expect(record.messages.filter(m=>m.content==='Current requirement')).toHaveLength(1);
        if(mode!=='transport')expect(record.operations[0]).toMatchObject({status:'failed',output:{kind:'context_overflow'}});
        expect((await client.events(session.id)).filter(e=>e.type==='context.overflow')).toHaveLength(['transport','no-checkpoint'].includes(mode)?0:1);
    } finally {await client.close();}
});

it('restores a committed overflow checkpoint after interruption without repeating the completed tool or input', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createSqliteSessionStore } = await import('./stores.js');
    const dir=await mkdtemp(join(tmpdir(),'overflow-restart-'));
    let taskCalls=0, effects=0, interrupted=false;
    const open=async()=>{
        const durable=await createSqliteSessionStore(join(dir,'sessions.sqlite'));
        const store={...durable,commit:async(...args:Parameters<typeof durable.commit>)=>{
            await durable.commit(...args);
            const event=args[3];
            if(!interrupted && event.type==='model.completed' && (event.data as {contextDecision?:{pending?:boolean}})?.contextDecision?.pending){
                interrupted=true;throw new Error('Interrupted after durable checkpoint commit');
            }
        }};
        return createHarness().compose({extensions:[{id:'restart',version:'1',apiVersion:1,roles:{
            store:()=>store,context:()=>agentContext('Rules',16000,{checkpointMaxTokens:128}),loop:()=>conversationalLoop(),
            tools:()=>({tools:()=>[],validate:(_name,args)=>({ok:true,args}),call:async()=>{effects++;return {ok:true,content:'Saved exactly once'};}}),
            policy:()=>({evaluate:async()=>({kind:'allow' as const})}),
            provider:()=>({structured:async()=>{throw new Error('unused');},turn:async request=>{
                if(request.system?.startsWith('Maintain'))return answer('The output was already saved. Verify and report; do not save again.');
                if(++taskCalls===1)return {...answer(''),stopReason:'tool_use',message:{role:'assistant',content:'',toolCalls:[{id:'effect',name:'write',args:{}}]}};
                if(taskCalls===2)throw new LLMContextOverflowError();
                expect(request.messages.some(m=>m.content.includes('already saved'))).toBe(true);
                return answer('Verified');
            }}),
        }}]});
    };
    let client=await open();
    try{
        const record=await client.create();
        await client.replaceMessages(record.id,0,Array.from({length:8},(_,i)=>[{role:'user' as const,content:`Earlier ${i}: `+'evidence '.repeat(100)},{role:'assistant' as const,content:'Reviewed'}]).flat());
        await client.submit(record.id,'Save and verify',{commandId:'accepted',metadata:{cursor:'boundary'}});
        const failed=await client.wait(record.id);
        expect(failed.status).toBe('failed');expect(interrupted).toBe(true);expect(effects).toBe(1);
        await client.close();client=await open();
        await client.resume(record.id);
        const restored=await client.wait(record.id);
        expect(restored.status).toBe('idle');expect(effects).toBe(1);expect(taskCalls).toBe(3);
        expect(restored.inputReceipts?.find(r=>r.commandId==='accepted')?.metadata).toEqual({cursor:'boundary'});
        expect(restored.messages.filter(m=>m.role==='user'&&m.content==='Save and verify')).toHaveLength(1);
        expect(restored.operations.filter(op=>op.kind==='tool')).toHaveLength(1);
    }finally{await client.close();await rm(dir,{recursive:true,force:true});}
});
