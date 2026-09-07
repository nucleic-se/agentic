import {describe,it,expect,vi} from 'vitest';
import {InMemoryStore} from './InMemoryStore.js';
const item=(key:string,value:unknown)=>({key,value,type:'semantic' as const,confidence:1,source:'test',tags:[]});
describe('memory candidate retrieval',()=>{
    it('rejects stale updates and expired items without overwriting the source', async () => {
        const store = new InMemoryStore();
        const written = await store.write({ ...item('build', 'npm test'), ttlDays: 1 });
        const updated = await store.update(written.id, { value: 'node --test', source: 'corrected' }, 1);
        await expect(store.update(written.id, { source: 'stale' }, 1)).rejects.toThrow('version conflict');
        expect(await store.get(written.id)).toEqual(updated);
        await expect(store.update(written.id, { id: 'replacement' } as never)).rejects.toThrow('patch field');
        const clock = vi.spyOn(Date, 'now').mockReturnValue(written.createdAt + 86400001);
        try { await expect(store.update(written.id, { value: 'resurrected' }, 2)).rejects.toThrow('not found'); }
        finally { clock.mockRestore(); }
    });
    it('honors zero and oversized bounds and skips an oversized candidate',async()=>{
        const store=new InMemoryStore();
        await store.write(item('large','x'.repeat(1000)));
        await store.write(item('small','ok'));
        expect(await store.query({limit:0})).toEqual([]);
        expect(await store.query({limit:3,tokenBudget:0})).toEqual([]);
        expect((await store.query({limit:3,tokenBudget:3})).map(x=>x.key)).toEqual(['small']);
        await expect(store.query({limit:-1})).rejects.toThrow(RangeError);
    });
    it('matches all lexical terms and does not leak mutable stored values',async()=>{
        const store=new InMemoryStore();
        const written=await store.write(item('build',{command:'npm test'}));
        (written.value as {command:string}).command='corrupted';
        await store.write(item('package','other'));
        const hits=await store.query({text:'BUILD npm',limit:10});
        expect(hits.map(x=>x.key)).toEqual(['build']);
        (hits[0].value as {command:string}).command='corrupted';
        expect((await store.get(written.id))?.value).toEqual({command:'npm test'});
    });
});
