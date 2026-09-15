import {test,before} from 'node:test'
import assert from 'node:assert/strict'
import {JSDOM,VirtualConsole} from 'jsdom'
import {adminOverviewBundle} from './admin-overview-fixture.ts'
import {balanceFixture,costsFixture,officialBillFixture} from './admin-costs-fixture.ts'

const initialTime=Date.parse('2026-09-15T08:00:00Z')
let appBundle:string,componentBundle:string
before(async()=>{[appBundle,componentBundle]=await Promise.all([adminOverviewBundle('app'),adminOverviewBundle('component')])})
const tick=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setTimeout(resolve,0))}
function snapshot(path:string,now=initialTime){
 const query=new URLSearchParams(path.split('?')[1]),data=costsFixture({from:query.get('from')!,to:query.get('to')!,timezone:query.get('timezone')!})
 data.snapshotAt=new Date(now).toISOString();data.totals.known_cost_usd_exact='0.174394544'
 data.officialBills=[officialBillFixture('openai','0.0485287',data),officialBillFixture('deepseek','0.19',data)]
 data.officialBills.forEach(bill=>{bill.fetched_at=data.snapshotAt});return data
}
type Options={mode?:'app'|'component';role?:string;props?:Record<string,unknown>;now?:()=>number;request?:(path:string,body?:unknown)=>unknown}
async function mount(options:Options={}){
 const errors:string[]=[],console=new VirtualConsole();console.on('jsdomError',e=>errors.push(e.message));console.on('error',e=>errors.push(String(e)))
 const dom=new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>',{url:'https://admin.example.invalid/admin/overview',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:console}),w=dom.window as any
 const calls:string[]=[],timers=new Map<number,{fn:()=>void;ms:number}>();let timerId=0
 const now=options.now||(()=>initialTime),RealDate=w.Date;w.Date=class extends RealDate{constructor(...args:any[]){super(...(args.length?args:[now()]))}static now(){return now()}}
 w.__props=options.props||{};w.__session={id:'fixture-owner',email:'owner@example.invalid',role:options.role||'owner'}
 w.setInterval=(fn:()=>void,ms:number)=>{timers.set(++timerId,{fn,ms});return timerId};w.clearInterval=(id:number)=>timers.delete(id);w.scrollTo=()=>{}
 Object.defineProperty(w.document,'visibilityState',{value:'visible',configurable:true})
 w.__request=async(path:string,body?:unknown)=>{
  calls.push(path)
  if(path==='session')return w.__session
  if(path==='overview')return {users:14,recentClients:2,todayCharacters:100,pendingTranslations:0,snapshotAt:new Date(now()).toISOString(),costs:{known_cost_usd_exact:'0.174394544',mismatches:0}}
  return options.request?options.request(path,body):path.startsWith('costs?')?snapshot(path,now()):path==='provider-balance'?balanceFixture(now()):{configured:true,message:'已同步'}
 }
 w.eval(options.mode==='component'?componentBundle:appBundle);await tick()
 return {w,calls,errors,timers,body:()=>w.document.body.textContent as string,official:()=>w.document.querySelector('.adm-overview-official'),characters:()=>w.document.querySelector('.adm-overview-characters'),run:(ms:number)=>{for(const item of [...timers.values()])if(item.ms===ms)item.fn()},refresh:async()=>{await w.__refreshOverview();await tick()},navigate:async(path:string)=>{await w.__navigate(path);await tick()},close:()=>{w.__dispose?.();dom.window.close()}}
}

test('real parent overview and costs route show the same exact official total and default monthly character count',async()=>{
 const h=await mount();try{
  assert.match(h.official().textContent,/\$0\.2385287/);assert.match(h.characters().textContent,/23,541/)
  assert.doesNotMatch(h.official().textContent,/0\.174394544|987654321/)
  assert.match(h.official().textContent,/OpenAI UTC · DeepSeek GMT\+8/)
  const overviewQuery=h.calls.find(path=>path.startsWith('costs?'))!
  assert.match(overviewQuery,/from=2026-09-01&to=2026-09-15&timezone=UTC&provider=/)
  await h.navigate('/admin/costs')
  const costCard=h.w.document.querySelector('.adm-official-cost');assert.match(costCard.textContent,/\$0\.2385287/)
  assert.equal(h.official(),null);assert.ok(h.calls.includes(overviewQuery))
  assert.equal(h.w.document.querySelector('.adm-local-cost-evidence').open,false)
  await h.navigate('/admin/overview');assert.match(h.official().textContent,/\$0\.2385287/)
  assert.equal(h.w.document.querySelector('.adm-official-cost'),null);assert.deepEqual(h.errors,[])
 }finally{h.close()}
})
test('overview uses parent five-second refresh and costs keeps ten-second refresh without duplicate component timers',async()=>{
 const h=await mount();try{
  assert.equal([...h.timers.values()].filter(timer=>timer.ms===5000).length,1)
  assert.equal([...h.timers.values()].filter(timer=>timer.ms===10000).length,0)
  let reads=h.calls.filter(path=>path.startsWith('costs?')).length;h.run(5000);await tick();assert.equal(h.calls.filter(path=>path.startsWith('costs?')).length,reads+1)
  Object.defineProperty(h.w.document,'visibilityState',{value:'hidden',configurable:true});reads++
  h.run(5000);await tick();assert.equal(h.calls.filter(path=>path.startsWith('costs?')).length,reads)
  Object.defineProperty(h.w.document,'visibilityState',{value:'visible',configurable:true});await h.navigate('/admin/costs')
  reads=h.calls.filter(path=>path.startsWith('costs?')).length;h.run(5000);await tick();assert.equal(h.calls.filter(path=>path.startsWith('costs?')).length,reads)
  h.run(10000);await tick();assert.equal(h.calls.filter(path=>path.startsWith('costs?')).length,reads+1)
  await h.navigate('/admin/overview');assert.equal([...h.timers.values()].filter(timer=>timer.ms===10000).length,0)
 }finally{h.close()}
})
test('missing official bills never display zero or local estimates, but genuine zero bills may total zero',async()=>{
 let state:'missing'|'partial'|'zero'='missing'
 const h=await mount({mode:'component',request:path=>{const data=snapshot(path);if(state==='missing')data.officialBills=[];if(state==='partial')data.officialBills.pop();if(state==='zero')data.officialBills.forEach(bill=>{bill.official_usd_exact='0'});return data}})
 try{
  assert.match(h.official().textContent,/尚缺官方账单/);assert.doesNotMatch(h.official().textContent,/\$0|0\.174394544/)
  state='partial';await h.refresh();assert.match(h.official().textContent,/已同步部分：\$0\.0485287/);assert.match(h.official().textContent,/待同步：DeepSeek/)
  assert.equal(h.official().querySelector('.adm-cost-value'),null)
  state='zero';await h.refresh();assert.equal(h.official().querySelector('.adm-cost-value').textContent,'$0.00')
 }finally{h.close()}
})
test('read failure preserves labeled prior data, recovery clears warning, and an empty current snapshot clears prior amounts',async()=>{
 let state:'good'|'failure'|'empty'='good'
 const h=await mount({mode:'component',request:path=>{if(state==='failure')throw new Error('synthetic unavailable');const data=snapshot(path);if(state==='empty')data.officialBills=[];return data}})
 try{
  state='failure';await h.refresh();assert.match(h.official().textContent,/\$0\.2385287/);assert.match(h.official().textContent,/读取失败.*保留上次账单/);assert.match(h.characters().textContent,/23,541/)
  state='good';await h.refresh();assert.doesNotMatch(h.official().textContent,/读取失败/)
  state='empty';await h.refresh();assert.match(h.official().textContent,/尚缺官方账单/);assert.doesNotMatch(h.official().textContent,/0\.2385287/)
 }finally{h.close()}
})
test('first-read failure never turns unknown monthly characters or absent official bills into zero',async()=>{
 const h=await mount({mode:'component',request:()=>{throw new Error('synthetic offline')}})
 try{assert.match(h.characters().textContent,/尚未取得/);assert.match(h.characters().textContent,/未显示为零/);assert.match(h.official().textContent,/尚缺官方账单/);assert.equal(h.official().querySelector('.adm-cost-value'),null)}finally{h.close()}
})
test('server-side authorization revocation clears old official amounts even while the rendered role remains owner',async()=>{
 for(const code of ['unauthorized','admin_forbidden']){
  let failure:Error|undefined
  const h=await mount({mode:'component',request:path=>{if(failure)throw failure;return snapshot(path)}})
  try{
   assert.match(h.official().textContent,/\$0\.2385287/)
   failure=new h.w.__ApiError('synthetic authorization revoked',code);await h.refresh()
   assert.doesNotMatch(h.official().textContent,/0\.2385287/);assert.doesNotMatch(h.characters().textContent,/23,541/)
   assert.match(h.official().textContent,/尚缺官方账单/);assert.match(h.characters().textContent,/尚未取得/)
  }finally{h.close()}
 }
})
test('real role grants keep monthly usage readable to support/finance while official bills and private API calls stay owner-only',async()=>{
 for(const role of ['admin','support','finance','editor']){
  const h=await mount({role});try{
   assert.equal(h.official(),null,role);assert.equal(Boolean(h.characters()),role!=='editor',role)
   assert.doesNotMatch(h.body(),/0\.2385287|0\.174394544/)
   assert.ok(!h.calls.includes('provider-balance')&&!h.calls.includes('billing-status'))
   assert.equal(h.calls.some(path=>path.startsWith('costs?')),role!=='editor')
   await h.navigate('/admin/costs')
   assert.equal(h.w.document.querySelector('.adm-official-cost'),null)
   assert.ok(!h.calls.includes('provider-balance')&&!h.calls.includes('billing-status'));assert.deepEqual(h.errors,[])
  }finally{h.close()}
 }
})
test('identity replacement and permission loss discard delayed old-owner reads without leaking prior amounts',async()=>{
 let resolveOld!:(value:unknown)=>void,resolveNew!:(value:unknown)=>void,count=0,oldPath=''
 const h=await mount({mode:'component',request:path=>{oldPath=path;return ++count===1?new Promise(resolve=>{resolveOld=resolve}):new Promise(resolve=>{resolveNew=resolve})}})
 try{
  h.w.__setProps({identity:'other-owner'});await tick();assert.equal(count,2)
  resolveOld(snapshot(oldPath));await tick();assert.doesNotMatch(h.official().textContent,/0\.2385287/)
  const other=snapshot(oldPath);other.officialBills[0].official_usd_exact='1';resolveNew(other);await tick();assert.match(h.official().textContent,/\$1\.19/)
  h.w.__setProps({officialAccess:false});await tick();assert.equal(h.official(),null);assert.doesNotMatch(h.body(),/1\.19/)
  h.w.__setProps({canReadCosts:false});await tick();resolveNew(snapshot(oldPath));await tick();assert.equal(h.characters(),null);assert.equal(h.official(),null)
 }finally{h.close()}
})
test('concurrent refresh requests coalesce and then load one newer snapshot',async()=>{
 let resolvePending!:(value:unknown)=>void,count=0,path=''
 const h=await mount({mode:'component',request:p=>{path=p;return ++count===1?snapshot(p):count===2?new Promise(resolve=>{resolvePending=resolve}):{...snapshot(p),officialBills:[]}}})
 try{
  const pending=h.w.__refreshOverview();await tick();const duplicate=h.w.__refreshOverview();h.w.__refreshOverview();await tick();assert.equal(count,2)
  resolvePending(snapshot(path));await Promise.all([pending,duplicate]);await tick();assert.equal(count,3);assert.match(h.official().textContent,/尚缺官方账单/)
 }finally{h.close()}
})
test('a stale overview request completing after route unmount cannot overwrite the costs page or its new overview instance',async()=>{
 let resolveLate!:(value:unknown)=>void,hold=false,latePath=''
 const h=await mount({request:path=>{
  if(!path.startsWith('costs?'))return path==='provider-balance'?balanceFixture(initialTime):{configured:true}
  if(hold){hold=false;latePath=path;return new Promise(resolve=>{resolveLate=resolve})}return snapshot(path)
 }})
 try{
  hold=true;h.run(5000);await tick();await h.navigate('/admin/costs');assert.match(h.w.document.querySelector('.adm-official-cost').textContent,/\$0\.2385287/)
  const stale=snapshot(latePath);stale.officialBills[0].official_usd_exact='500';resolveLate(stale);await tick();assert.doesNotMatch(h.body(),/500\.19/)
  await h.navigate('/admin/overview');assert.match(h.official().textContent,/\$0\.2385287/);assert.doesNotMatch(h.body(),/500\.19/);assert.deepEqual(h.errors,[])
 }finally{h.close()}
})
test('UTC month rollover requests the new calendar period and rejects a response for the old month',async()=>{
 let now=Date.parse('2026-09-30T23:59:58Z'),old:ReturnType<typeof snapshot>|undefined,returnOld=false
 const h=await mount({mode:'component',now:()=>now,request:path=>{if(returnOld)return old;return old=snapshot(path,now)}})
 try{
  assert.match(h.characters().textContent,/2026-09-01 至 2026-09-30/)
  now=Date.parse('2026-10-01T00:00:03Z');returnOld=true;await h.refresh()
  assert.match(h.calls.at(-1)!,/from=2026-10-01&to=2026-10-01/);assert.match(h.characters().textContent,/账期数据尚未核实/)
  assert.doesNotMatch(h.characters().textContent,/2026-10-01 至 2026-10-01/,'An old response must not be labeled as the new month')
  returnOld=false;await h.refresh();assert.match(h.characters().textContent,/2026-10-01 至 2026-10-01/);assert.doesNotMatch(h.characters().textContent,/读取失败/)
 }finally{h.close()}
})
test('current API statement delays are explicit, while manual historical statements retain their real sample date',async()=>{
 const h=await mount({mode:'component',request:path=>{const data=snapshot(path);data.officialBills.forEach(bill=>{bill.fetched_at=new Date(initialTime-11*60000).toISOString()});return data}})
 try{assert.match(h.official().textContent,/\$0\.2385287/);assert.match(h.official().textContent,/官方账单同步有延迟/);assert.match(h.official().textContent,/07:49/)}finally{h.close()}
})
