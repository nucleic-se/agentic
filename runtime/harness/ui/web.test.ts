import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionClient, SessionRecord, SessionUpdate } from '../types.js';
import { startWebUi, webUiExtension } from './web.js';
import { WEB_SCRIPT } from './web-page.js';
import { Script, createContext, runInContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
const TOKEN = 'testing-agentic-browser-token-123456';
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map(close => close())); });
function fake() {
    const record: SessionRecord = { id:'session-1',title:'A session',revision:1,createdAt:1,updatedAt:1,status:'idle',messages:[],operations:[],approvals:[],commandIds:[],queue:[],usage:{inputTokens:0,outputTokens:0},composition:'test' };
    let listener: ((event: SessionUpdate) => void) | undefined;
    const client: SessionClient = {create:vi.fn(async title => ({...record,title:title ?? record.title})),list:vi.fn(async()=>[record]),get:vi.fn(async()=>record),events:vi.fn(async()=>[]),submit:vi.fn(async()=>{}),cancel:vi.fn(async()=>{}),approve:vi.fn(async()=>{}),fork:vi.fn(async()=>({...record,id:'fork-1'})),resume:vi.fn(async()=>{}),subscribe:vi.fn(fn=>{listener=fn;return()=>{listener=undefined;};}),composition:vi.fn(()=>[{id:'demo',version:'1',roles:['loop']}]),close:vi.fn(async()=>{})};
    return {client,emit:(event: SessionUpdate)=>listener?.(event)};
}
async function setup() {
    const f = fake(); const server = await startWebUi(f.client,{token:TOKEN}); closers.push(server.close);
    const request = (path: string, data?: unknown, headers?: Record<string,string>) => fetch(server.url + path, {method:data === undefined ? 'GET':'POST',headers:{...(data === undefined ? {}:{'Content-Type':'application/json'}),...headers},body:data === undefined ? undefined:JSON.stringify(data)});
    const login = await request('/api/login',{token:TOKEN},{Origin:server.url}); const cookie = login.headers.get('set-cookie')!.split(';')[0];
    return {...f,...server,request,cookie};
}
describe('web UI adapter',()=>{
    it('requires a long token and serves a dependency-free safe page',async()=>{
        await expect(startWebUi(fake().client,{token:'short'})).rejects.toThrow('24');
        const s = await setup(); const response = await s.request('/');
        expect(response.status).toBe(200); expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.text()).not.toContain(TOKEN);
        expect(()=>new Script(WEB_SCRIPT)).not.toThrow();
        expect(WEB_SCRIPT).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
    });
    it('authenticates APIs and stream; refuses cross-origin login and mutation',async()=>{
        const s = await setup();
        expect((await s.request('/api/sessions')).status).toBe(401);
        expect((await s.request('/api/stream')).status).toBe(401);
        expect((await s.request('/api/login',{token:'wrong'})).status).toBe(401);
        expect((await s.request('/api/login',{token:TOKEN},{Origin:'https://evil.example'})).status).toBe(403);
        expect((await s.request('/api/sessions',{}, {Cookie:s.cookie,Origin:'https://evil.example'})).status).toBe(403);
        expect((await s.request('/api/sessions',{}, {Cookie:s.cookie,Origin:s.url,'Sec-Fetch-Site':'cross-site'})).status).toBe(403);
        expect((await s.request('/api/sessions',undefined,{Cookie:s.cookie})).status).toBe(200);
        const login = await s.request('/api/login',{token:TOKEN});
        expect(login.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict');
    });
    it('bounds body consumption and rejects malformed commands',async()=>{
        const s = await setup(); const headers = {Cookie:s.cookie,Origin:s.url};
        expect((await s.request('/api/sessions',{title:'a'.repeat(70_000)},headers)).status).toBe(413);
        expect((await s.request('/api/sessions/session-1/submit',{content:'hello',commandId:'c',mode:'bad'},headers)).status).toBe(400);
        expect((await s.request('/api/sessions/session-1/approve',{approvalId:'a',allow:'yes'},headers)).status).toBe(400);
        expect((await s.request('/api/sessions/session-1/events?after=-1',undefined,headers)).status).toBe(400);
        expect((await s.request('/api/login',{token:TOKEN},{'Content-Type':'application/json-unsupported'})).status).toBe(415);
        expect(s.client.submit).not.toHaveBeenCalled();
    });
    it('routes session commands through the shared client',async()=>{
        const s = await setup(); const h = {Cookie:s.cookie,Origin:s.url};
        expect((await s.request('/api/sessions',{title:'Build a thing'},h)).status).toBe(201);
        expect(s.client.create).toHaveBeenCalledWith('Build a thing');
        await s.request('/api/sessions?limit=2&offset=1',undefined,h);
        expect(s.client.list).toHaveBeenCalledWith({ limit: 2, offset: 1 });
        await s.request('/api/sessions/session-1/events?after=4&limit=2',undefined,h);
        expect(s.client.events).toHaveBeenCalledWith('session-1',4,2);
        expect((await (await s.request('/api/sessions/session-1',undefined,h)).json()).id).toBe('session-1');
        await s.request('/api/sessions/session-1/events?after=4',undefined,h); expect(s.client.events).toHaveBeenCalledWith('session-1',4);
        expect((await s.request('/api/sessions/session-1/submit',{content:'hello',commandId:'c1',mode:'enqueue'},h)).status).toBe(202);
        expect(s.client.submit).toHaveBeenCalledWith('session-1','hello',{commandId:'c1',mode:'enqueue'});
        await s.request('/api/sessions/session-1/approve',{approvalId:'a1',allow:true},h); expect(s.client.approve).toHaveBeenCalledWith('session-1','a1',true);
        for(const action of ['cancel','resume','fork']) expect((await s.request('/api/sessions/session-1/'+action,{},h)).ok).toBe(true);
        expect((await (await s.request('/api/composition',undefined,h)).json())[0].id).toBe('demo');
        await s.request('/api/logout',{},h); expect((await s.request('/api/sessions',undefined,h)).status).toBe(401);
    });
    it('streams updates and detaches without closing the client',async()=>{
        const s = await setup(); const response = await s.request('/api/stream',undefined,{Cookie:s.cookie}); const reader = response.body!.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: ready');
        s.emit({sessionId:'session-1',type:'delta',text:'Hello'});
        expect(new TextDecoder().decode((await reader.read()).value)).toContain('Hello');
        await reader.cancel(); await s.close(); expect(s.client.close).not.toHaveBeenCalled();
        expect(webUiExtension({token:TOKEN}).id).toBe('agentic.ui.web');
    });
});

function browserHarness() {
    const elements = new Map<string, any>();
    const element = (id: string) => {
        if (!elements.has(id)) elements.set(id, { value:'', hidden:false, disabled:false, textContent:'', classList:{add(){},remove(){}}, replaceChildren(){} });
        return elements.get(id);
    };
    const context = createContext({ document:{getElementById:element}, fetch:()=>new Promise(()=>{}), crypto:webcrypto, setTimeout, clearTimeout, Uint8Array, console });
    runInContext(WEB_SCRIPT,context);
    return {context,element};
}
describe('browser command and streaming state',()=>{
    it('reuses the command ID after an uncertain submit response',async()=>{
        const {context,element} = browserHarness(); const submitted: any[] = [];
        context.capture = async (_path: string, command: unknown) => {submitted.push(command); if (submitted.length === 1) throw new Error('Connection lost after acceptance'); return {ok:true};};
        runInContext("selected = 'session-1'; api = capture; refresh = async () => {};",context);
        element('message').value = 'Implement the task'; element('mode').value = 'steer';
        await element('composer').onsubmit({preventDefault(){}});
        expect(element('message').value).toBe('Implement the task');
        await element('composer').onsubmit({preventDefault(){}});
        expect(submitted).toHaveLength(2);
        expect(submitted[0].commandId).toBe(submitted[1].commandId);
        expect(element('message').value).toBe('');
        element('message').value = 'Implement the task';
        await element('composer').onsubmit({preventDefault(){}});
        expect(submitted[2].commandId).not.toBe(submitted[1].commandId);
    });
    it('preserves live text across unrelated durable updates and clears completed operations',()=>{
        const {context} = browserHarness();
        runInContext("delta = 'Already streamed'; deltaOperation = 'model-1'; reconcileDelta({operations:[{id:'model-1',status:'intent'}]});",context);
        expect(runInContext('delta',context)).toBe('Already streamed');
        runInContext("reconcileDelta({operations:[{id:'another-operation',status:'completed'}]});",context);
        expect(runInContext('delta',context)).toBe('Already streamed');
        runInContext("reconcileDelta({operations:[{id:'model-1',status:'completed'}]});",context);
        expect(runInContext('delta',context)).toBe('');
    });
});
