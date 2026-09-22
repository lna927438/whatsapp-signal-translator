import {test,before} from 'node:test'
import assert from 'node:assert/strict'
import {JSDOM,VirtualConsole} from 'jsdom'
import {ReadPolling} from '../website/src/admin/readPolling.ts'
import {adminOverviewBundle} from './admin-overview-fixture.ts'
import {adminCostsBundle,costsFixture,fundingBalanceFixture} from './admin-costs-fixture.ts'

let overviewBundle:string,costsBundle:string
before(async()=>{[overviewBundle,costsBundle]=await Promise.all([adminOverviewBundle(),adminCostsBundle()])})
const tick=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setTimeout(resolve,0))}
const deferred=()=>{let resolve!:(value:unknown)=>void,reject!:(reason:unknown)=>void;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}

async function mount(mode:'overview'|'costs'){
  const errors:string[]=[],console=new VirtualConsole();console.on('jsdomError',e=>errors.push(e.message))
  const dom=new JSDOM('<div id="app"></div>',{url:'https://admin.example.invalid/admin/'+mode,runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:console}),w=dom.window as any
  const timers=new Map<number,{fn:()=>void;ms:number}>(),calls:string[]=[];let id=0,now=Date.parse('2026-09-22T04:00:00Z')
  const RealDate=w.Date;w.Date=class extends RealDate{constructor(...args:any[]){super(...(args.length?args:[now]))}static now(){return now}}
  const visible=(state:string)=>Object.defineProperty(w.document,'visibilityState',{value:state,configurable:true});visible('visible')
  w.__session={id:'fixture-owner',email:'owner@example.invalid',role:'owner'};w.__officialAccess=true;w.scrollTo=()=>{}
  w.setInterval=(fn:()=>void,ms:number)=>{timers.set(++id,{fn,ms});return id};w.clearInterval=(id:number)=>timers.delete(id)
  const fixture=(path:string)=>{
    if(path==='session')return w.__session
    if(path==='overview')return {users:30,recentClients:25,todayCharacters:51010,pendingTranslations:0,costs:{mismatches:0},snapshotAt:new Date(now).toISOString()}
    if(path==='provider-balance')return fundingBalanceFixture(now)
    if(path.startsWith('costs?')){const q=new URLSearchParams(path.slice(6));return {...costsFixture({from:q.get('from')!,to:q.get('to')!,timezone:q.get('timezone')!}),snapshotAt:new Date(now).toISOString()}}
    return {configured:true}
  }
  let read:(path:string)=>unknown=fixture
  w.__request=async(path:string)=>{calls.push(path);return read(path)}
  w.eval(mode==='overview'?overviewBundle:costsBundle);await tick()
  return {w,calls,errors,fixture,visible,read:(next:(path:string)=>unknown)=>{read=next},count:(prefix:string)=>calls.filter(path=>path.startsWith(prefix)).length,
    poll:async(ms:number)=>{now+=ms;for(const timer of [...timers.values()])timer.fn();await tick()},
    manual:async()=>{if(mode==='overview')w.document.querySelector('.adm-heading button').click();else w.document.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick()},
    body:()=>w.document.body.textContent as string,close:()=>{w.__dispose();dom.window.close()}}
}

test('polling failures back off after completion up to two minutes and success restores normal cadence',()=>{
  let now=0;const cadence=new ReadPolling(15000,120000,()=>now)
  assert.equal(cadence.due(),true)
  for(const delay of [30000,60000,120000,120000]){cadence.failed();now+=delay-1;assert.equal(cadence.due(),false);now++;assert.equal(cadence.due(),true)}
  cadence.succeeded();now+=14999;assert.equal(cadence.due(),false);now++;assert.equal(cadence.due(),true)
  cadence.failed();cadence.reset();assert.equal(cadence.due(),true)
})

test('a successful request taking time does not skip the next thirty-second timer tick',()=>{
 let now=0;const cadence=new ReadPolling(30000,120000,()=>now),startedAt=now
 now=900;cadence.succeeded(startedAt);now=29999;assert.equal(cadence.due(),false);now=30000;assert.equal(cadence.due(),true)
 now=65000;cadence.succeeded(30000);assert.equal(cadence.due(),true,'Completed slow calls do not overlap, but no additional full interval is imposed')
 cadence.failed();now+=59999;assert.equal(cadence.due(),false);now++;assert.equal(cadence.due(),true,'Failures still back off from completion')
})

test('real overview reads at most every fifteen seconds, aggregates thirty seconds, and none while hidden',async()=>{
  const h=await mount('overview');try{
    const overview=h.count('overview'),costs=h.count('costs?')
    await h.poll(14999);assert.equal(h.count('overview'),overview);assert.equal(h.count('costs?'),costs)
    await h.poll(1);assert.equal(h.count('overview'),overview+1);assert.equal(h.count('costs?'),costs)
    await h.poll(15000);assert.equal(h.count('overview'),overview+2);assert.equal(h.count('costs?'),costs+1)
    h.visible('hidden');const before=h.calls.length;await h.poll(120000);assert.equal(h.calls.length,before)
    h.visible('visible');h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));await tick();assert.equal(h.count('overview'),overview+3)
    assert.deepEqual(h.errors,[])
  }finally{h.close()}
})

test('overview failures do not hammer the server or clear verified values; manual retry bypasses delay',async()=>{
  const h=await mount('overview');try{
    h.read(path=>{if(path==='overview')throw Error('synthetic temporary outage');return h.fixture(path)})
    await h.poll(15000);const failed=h.count('overview');assert.match(h.body(),/保留上次数据/);assert.match(h.body(),/51,010/)
    await h.poll(15000);assert.equal(h.count('overview'),failed)
    await h.poll(15000);assert.equal(h.count('overview'),failed+1)
    await h.poll(30000);assert.equal(h.count('overview'),failed+1)
    h.read(h.fixture);await h.manual();assert.equal(h.count('overview'),failed+2);assert.doesNotMatch(h.body(),/synthetic temporary outage/)
    assert.deepEqual(h.errors,[])
  }finally{h.close()}
})

test('slow overview billing failures cannot queue an immediate automatic retry',async()=>{
  const h=await mount('overview'),pending=deferred();try{
    h.read(path=>path.startsWith('costs?')?pending.promise:h.fixture(path))
    await h.poll(30000);const costs=h.count('costs?');await h.poll(30000);await h.poll(30000);assert.equal(h.count('costs?'),costs)
    pending.reject(Error('synthetic slow costs'));await tick();assert.equal(h.count('costs?'),costs);assert.match(h.body(),/保留上次数据/)
    await h.poll(30000);assert.equal(h.count('costs?'),costs)
    h.read(h.fixture);await h.poll(30000);assert.equal(h.count('costs?'),costs+1);assert.doesNotMatch(h.body(),/synthetic slow costs/)
  }finally{h.close()}
})

test('costs page coalesces slow automatic reads, backs off, keeps stale labels, and allows manual recovery',async()=>{
  const h=await mount('costs'),pending=deferred();try{
    h.read(path=>path.startsWith('costs?')?pending.promise:h.fixture(path))
    await h.poll(30000);const costs=h.count('costs?');await h.poll(60000);assert.equal(h.count('costs?'),costs)
    pending.reject(new h.w.Error('synthetic slow costs'));await tick();assert.equal(h.count('costs?'),costs);assert.match(h.body(),/23,541/);assert.match(h.body(),/synthetic slow costs/)
    await h.poll(30000);assert.equal(h.count('costs?'),costs)
    const recovery=deferred();h.read(path=>path.startsWith('costs?')?recovery.promise:h.fixture(path));await h.manual();assert.equal(h.count('costs?'),costs+1);assert.match(h.body(),/synthetic slow costs/)
    recovery.resolve(h.fixture(h.calls.filter(p=>p.startsWith('costs?')).at(-1)!));await tick();assert.doesNotMatch(h.body(),/synthetic slow costs/)
    h.visible('hidden');const before=h.calls.length;await h.poll(120000);assert.equal(h.calls.length,before)
    assert.deepEqual(h.errors,[])
  }finally{h.close()}
})
