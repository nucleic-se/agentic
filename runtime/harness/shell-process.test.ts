import * as receipts from './shell-receipts.js';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codingToolRuntime } from './coding.js';
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'agentic-process-test-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const owner = { sessionId: 'test-session', callId: 'launch-one' };
function runtime() { return codingToolRuntime(root, { outputDirectory: join(root, 'output'), processDirectory: join(root, 'processes') }); }
async function finish(id: string) {
    const reopened = runtime();
    for (let i = 0; i < 30; i++) {
        const result = await reopened.call('shell_poll', { id, yield_after_ms: 100 }, owner);
        if ((result.data as { status: string }).status === 'unknown') throw new Error(JSON.stringify(result));
        if ((result.data as { status: string }).status !== 'running') return result;
    }
    throw new Error('Process did not finish');
}
it('yields without killing and reconnects without launching a second command', async () => {
    await writeFile(join(root, 'job.cjs'), "require('node:fs').appendFileSync('runs','1'); setTimeout(()=>{require('node:fs').writeFileSync('finished','yes');console.log('finished')},400);");
    const args = { command: 'node job.cjs', timeout_ms: 1 };
    const started = await runtime().call('shell_run', args, owner);
    expect(started).toMatchObject({ ok: true, data: { status: 'running' } });
    const id = (started.data as { processId: string }).processId;
    const repeated = await runtime().call('shell_run', args, owner);
    expect((repeated.data as { processId: string }).processId).toBe(id);
    const done = await finish(id);
    expect(done).toMatchObject({ ok: true, data: { status: 'completed', exitCode: 0 } });
    expect(await readFile(join(root, 'runs'), 'utf8')).toBe('1');
    expect(await readFile(join(root, 'finished'), 'utf8')).toBe('yes');
});
it('rejects cross-session handles and a changed command under the same call identity', async () => {
    const started = await runtime().call('shell_run', { command: 'printf ok' }, owner);
    const id = (started.data as { processId: string }).processId;
    expect((await runtime().call('shell_poll', { id }, { sessionId: 'other' })).ok).toBe(false);
    expect((await runtime().call('shell_cancel', { id }, { sessionId: 'other' })).ok).toBe(false);
    expect((await runtime().call('shell_run', { command: 'printf different' }, owner)).ok).toBe(false);
});
it('does not launch when already aborted; abort after launch only stops waiting', async () => {
    const controller = new AbortController(); controller.abort();
    const rejected = await runtime().call('shell_run', { command: 'touch never' }, { ...owner, signal: controller.signal });
    expect(rejected.ok).toBe(false);
    const active = new AbortController();
    const pending = runtime().call('shell_run', { command: 'sleep 0.4; touch completed', yield_after_ms: 1000 }, { ...owner, signal: active.signal });
    setTimeout(() => active.abort(), 200);
    const launched = await pending;
    expect(launched).toMatchObject({ ok: true, data: { status: 'running' } });
    expect(await finish((launched.data as { processId: string }).processId)).toMatchObject({ ok: true });
    expect(await readFile(join(root, 'completed'), 'utf8')).toBe('');
});
it('cancels explicitly and preserves a terminal receipt without claiming rollback', async () => {
    const launched = await runtime().call('shell_run', { command: 'sleep 20', yield_after_ms: 100 }, owner);
    const id = (launched.data as { processId: string }).processId;
    const requested = await runtime().call('shell_cancel', { id }, owner);
    expect(requested.ok).toBe(true);
    const done = await finish(id);
    expect(done).toMatchObject({ ok: true, data: { status: 'cancelled' } });
    expect(done.content).toContain('effects');
});
it('uses an execution deadline only when explicitly supplied', async () => {
    const launched = await runtime().call('shell_run', { command: 'sleep 20', yield_after_ms: 1, execution_timeout_ms: 200 }, owner);
    const done = await finish((launched.data as { processId: string }).processId);
    expect(done).toMatchObject({ ok: true, data: { status: 'deadline_exceeded' } });
});

it('concurrent duplicate requests launch once and allow changing only the wait budget', async () => {
    const args = { command: "printf 1 >> once; sleep 0.2", yield_after_ms: 1 };
    const results = await Promise.all([runtime().call('shell_run', args, owner), runtime().call('shell_run', args, owner)]);
    expect(results.every(r => r.ok)).toBe(true);
    const id = (results[0].data as { processId: string }).processId;
    expect((results[1].data as { processId: string }).processId).toBe(id);
    expect((await runtime().call('shell_run', {...args,yield_after_ms:2}, owner)).ok).toBe(true);
    await finish(id);
    expect(await readFile(join(root,'once'),'utf8')).toBe('1');
});
it('lists retained handles across a handoff only within the host-owned logical scope', async () => {
    const options = { outputDirectory: join(root,'output'), processDirectory:join(root,'processes'),processOwner:'conversation-one' };
    const launched = await codingToolRuntime(root,options).call('shell_run',{command:'printf ok'},owner);
    const id = (launched.data as {processId:string}).processId;
    const next = codingToolRuntime(root,options);
    expect((await next.call('shell_poll',{id},{sessionId:'new-physical-session'})).ok).toBe(true);
    expect((await next.call('shell_list',{}, {sessionId:'new-physical-session'})).content).toContain(id);
    expect((await codingToolRuntime(root,{...options,processOwner:'conversation-two'}).call('shell_poll',{id},owner)).ok).toBe(false);
});
it('rejects conflicting wait aliases without dispatching', async () => {
    expect(runtime().validate('shell_run',{command:'touch never',timeout_ms:1,yield_after_ms:2}).ok).toBe(false);
});

it('keeps accepted identity unresolved when a terminal receipt cannot be read', async()=>{
 const started=await runtime().call('shell_run',{command:'printf ok'},owner);
 const id=(started.data as {processId:string}).processId;
 await writeFile(join(root,'processes',id,'receipt.json'),'broken',{mode:0o600});
 const result=await runtime().call('shell_poll',{id},owner);
 expect(result).toMatchObject({ok:false,errorKind:'unknown',data:{processId:id,status:'unknown'}});
 expect(result.content).toContain('do not relaunch');
});
it('a killed supervisor leaves uncertainty and cannot acknowledge cancellation', async()=>{
 const started=await runtime().call('shell_run',{command:'sleep 20',yield_after_ms:100},owner);
 const id=(started.data as {processId:string}).processId;
 let receipt: {supervisorPid:number;commandPid:number};
 for(let i=0;;i++){
  receipt=JSON.parse(await readFile(join(root,'processes',id,'receipt.json'),'utf8'));
  if(receipt.commandPid)break;
  if(i>100)throw new Error('Missing command identity');
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 process.kill(receipt.supervisorPid,'SIGKILL');
 await new Promise(resolve=>setTimeout(resolve,40));
 try{
  expect(await runtime().call('shell_poll',{id},owner)).toMatchObject({ok:false,errorKind:'unknown'});
  expect((await runtime().call('shell_cancel',{id},owner)).content).toContain('cannot be confirmed');
 }finally{try{process.kill(-receipt.commandPid,'SIGKILL');}catch{}}
});

it('keeps commands alive after the calling Node process exits and retrieves their receipt',async()=>{
 const entry=fileURLToPath(new URL('../../dist/runtime/harness/coding.js',import.meta.url));
 const code=`import {codingToolRuntime} from ${JSON.stringify('file://'+entry)};const r=codingToolRuntime(${JSON.stringify(root)},{outputDirectory:${JSON.stringify(join(root,'output'))},processDirectory:${JSON.stringify(join(root,'processes'))}});const result=await r.call('shell_run',{command:'sleep 0.3; printf 1 >> once',yield_after_ms:0},{sessionId:'test-session',callId:'parent-exit'});console.log(JSON.stringify(result));process.exit(0);`;
 const result=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8'}));
 expect(result).toMatchObject({ok:true,data:{status:'running'}});
 expect(await finish(result.data.processId)).toMatchObject({ok:true,data:{status:'completed',exitCode:0}});
 expect(await readFile(join(root,'once'),'utf8')).toBe('1');
});
it('missing preparation receipts and invalid receipt statuses remain unresolved',async()=>{
 const started=await runtime().call('shell_run',{command:'printf ok'},owner);
 const id=(started.data as {processId:string}).processId;
 const file=join(root,'processes',id,'receipt.json');
 await writeFile(file,JSON.stringify({status:'invented',startedAt:Date.now()}),{mode:0o600});
 expect(await runtime().call('shell_poll',{id},owner)).toMatchObject({ok:false,errorKind:'unknown'});
 await rm(file);
 await rm(join(root,'processes',id,'launcher.json'));
 const requestFile=join(root,'processes',id,'request.json');
 const request=JSON.parse(await readFile(requestFile,'utf8'));request.createdAt=Date.now()-10000;
 await writeFile(requestFile,JSON.stringify(request),{mode:0o600});
 expect(await runtime().call('shell_poll',{id},owner)).toMatchObject({ok:true,data:{status:'running',phase:'starting'}});
});

it('rereads completion published while checking supervisor liveness',async()=>{
 const started=await runtime().call('shell_run',{command:'printf ok'},owner);
 const id=(started.data as {processId:string}).processId;
 const file=join(root,'processes',id,'receipt.json');
 await writeFile(file,JSON.stringify({status:'running',startedAt:Date.now(),supervisorPid:999999,supervisorBirth:'old'}),{mode:0o600});
 const spy=vi.spyOn(receipts,'processIdentity').mockImplementationOnce(()=>{
  writeFileSync(file,JSON.stringify({status:'completed',startedAt:Date.now(),finishedAt:Date.now(),exitCode:0,signal:null}),{mode:0o600});return undefined;
 });
 try{expect(await runtime().call('shell_poll',{id},owner)).toMatchObject({ok:true,data:{status:'completed',exitCode:0}});}
 finally{spy.mockRestore();}
});

it('recognized but incomplete terminal receipts cannot report success',async()=>{
 const started=await runtime().call('shell_run',{command:'printf ok'},owner);
 const id=(started.data as {processId:string}).processId;
 for(const status of ['completed','failed','cancelled','deadline_exceeded']){
  await writeFile(join(root,'processes',id,'receipt.json'),JSON.stringify({status,startedAt:Date.now()}),{mode:0o600});
  expect(await runtime().call('shell_poll',{id},owner)).toMatchObject({ok:false,errorKind:'unknown'});
 }
});

it('reads valid pinned receipt snapshots while the pathname is atomically replaced',async()=>{
 const file=join(root,'receipt.json');
 await receipts.writeReceipt(file,{status:'running',startedAt:1});
 const {rename}=await import('node:fs/promises');
 const replacer=(async()=>{for(let i=0;i<100;i++)await receipts.writeReceipt(file,{status:'running',startedAt:i+1});})();
 for(let i=0;i<100;i++)expect((await receipts.readReceipt<{status:string}>(file)).status).toBe('running');
 await replacer;
});
