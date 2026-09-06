import {describe,it,expect} from 'vitest';
import {InMemoryStore} from './InMemoryStore.js';
const item=(key:string,value:unknown)=>({key,value,type:'semantic' as const,confidence:1,source:'test',tags:[]});
describe('memory candidate retrieval',()=>{
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
