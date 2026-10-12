import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Exercise the built consumer API as well as source tests for the receipt manager.
import { codingToolRuntime } from '../../dist/runtime/harness/coding.js';
it('waits in the host for completion and never launches another command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shell-wait-'));
    try {
        const runtime = codingToolRuntime(root, { processDirectory: join(root, 'processes'), outputDirectory: join(root, 'output') });
        const owner = { sessionId: 'test', callId: 'once' };
        const launched = await runtime.call('shell_run', { command: 'sleep 0.2; printf 1 >> once', yield_after_ms: 1 }, owner);
        const result = await runtime.call('shell_wait', { id: (launched.data as any).processId }, owner);
        expect(result).toMatchObject({ ok: true, data: { status: 'completed', exitCode: 0 } });
        expect(await readFile(join(root, 'once'), 'utf8')).toBe('1');
    } finally { await rm(root, { recursive: true, force: true }); }
});
it('interrupting a wait retains the live command for a later waiter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shell-wait-'));
    try {
        const runtime = codingToolRuntime(root, { processDirectory: join(root, 'processes'), outputDirectory: join(root, 'output') });
        const owner = { sessionId: 'test', callId: 'once' }, controller = new AbortController();
        const launched = await runtime.call('shell_run', { command: 'sleep 0.4; printf 1 >> once', yield_after_ms: 1 }, owner);
        const waiting = runtime.call('shell_wait', { id: (launched.data as any).processId }, { ...owner, signal: controller.signal });
        setTimeout(() => controller.abort(), 100);
        expect(await waiting).toMatchObject({ ok: true, data: { status: 'running' } });
        expect(await runtime.call('shell_wait', { id: (launched.data as any).processId }, owner)).toMatchObject({ ok: true, data: { status: 'completed' } });
        expect(await readFile(join(root, 'once'), 'utf8')).toBe('1');
    } finally { await rm(root, { recursive: true, force: true }); }
});
it('cancelling a harness wait commits the running handle without creating an unknown tool operation', async () => {
    const { createHarness } = await import('./host.js');
    const { conversationalLoop } = await import('./loops.js');
    const { MemorySessionStore } = await import('./stores.js');
    const { budgetedContext } = await import('./context.js');
    const root = await mkdtemp(join(tmpdir(), 'harness-wait-'));
    const runtime = codingToolRuntime(root, {processDirectory:join(root,'processes'),outputDirectory:join(root,'output')});
    let id='', calls=0, waiting!:()=>void;
    const waitStarted = new Promise<void>(resolve=>{waiting=resolve;});
    const tools={tools:()=>runtime.tools(),validate:runtime.validate.bind(runtime),call:async (name:string,args:any,options:any)=>{
        if(name==='shell_wait')waiting();const result=await runtime.call(name,args,options);
        if(name==='shell_run')id=(result.data as any).processId;return result;
    }};
    const client=await createHarness().compose({extensions:[{id:'wait-test',version:'1',apiVersion:1,roles:{
        store:()=>new MemorySessionStore(),loop:()=>conversationalLoop(),context:()=>budgetedContext('',16000),tools:()=>tools,
        policy:()=>({evaluate:async()=>({kind:'allow' as const})}),provider:()=>({structured:async()=>{throw Error('unused')},turn:async()=>({
            message:{role:'assistant' as const,content:'',toolCalls:[calls++===0?{id:'launch',name:'shell_run',args:{command:'sleep 0.5; printf 1 >> once',yield_after_ms:1}}:{id:'wait',name:'shell_wait',args:{id}}]},
            stopReason:'tool_use' as const,usage:{inputTokens:1,outputTokens:1}})}),
    }}]});
    try{
        const session=await client.create();await client.submit(session.id,'work',{commandId:'original'});
        await waitStarted;await client.cancel(session.id);const record=await client.wait(session.id);
        expect(record.status).toBe('interrupted');expect(record.operations.some(op=>op.kind==='tool' && op.status==='unknown')).toBe(false);
        expect(calls).toBe(2);expect(await runtime.call('shell_wait',{id},{sessionId:session.id})).toMatchObject({ok:true,data:{status:'completed'}});
        expect(await readFile(join(root,'once'),'utf8')).toBe('1');
    }finally{await client.close();await rm(root,{recursive:true,force:true})}
});
