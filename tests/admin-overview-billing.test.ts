import {test,before} from 'node:test'
import assert from 'node:assert/strict'
import {JSDOM,VirtualConsole} from 'jsdom'
import {adminOverviewBundle} from './admin-overview-fixture.ts'
import {fundingBalanceFixture,costsFixture,officialBillFixture} from './admin-costs-fixture.ts'

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
 w.setInterval=(fn:()=>void,ms:number)=>{timers.set(++timerId,{fn,ms});return timerId};w.clearInterval=(id:number)=>timers.delete(id);w.scrollTo=()=>{};w.HTMLDialogElement.prototype.showModal=function(){this.open=true}
 Object.defineProperty(w.document,'visibilityState',{value:'visible',configurable:true})
 w.__request=async(path:string,body?:unknown)=>{
  calls.push(path)
  if(path==='session')return w.__session
  if(path==='overview')return {users:14,recentClients:2,todayCharacters:100,pendingTranslations:0,snapshotAt:new Date(now()).toISOString(),costs:{known_cost_usd_exact:'0.174394544',mismatches:0}}
  return options.request?options.request(path,body):path.startsWith('costs?')?snapshot(path,now()):path==='provider-balance'?fundingBalanceFixture(now()):{configured:true,message:'已同步'}
 }
 w.eval(options.mode==='component'?componentBundle:appBundle);await tick()
 return {w,calls,errors,timers,body:()=>w.document.body.textContent as string,official:()=>w.document.querySelector('.adm-overview-funding'),characters:()=>w.document.querySelector('.adm-overview-characters'),run:(ms:number)=>{for(const item of [...timers.values()])if(item.ms===ms)item.fn()},refresh:async()=>{await w.__refreshOverview();await tick()},navigate:async(path:string)=>{await w.__navigate(path);await tick()},close:()=>{w.__dispose?.();dom.window.close()}}
}


test('real parent overview and costs share lifetime 20 / 19.70 / 0.30 funds, independently of monthly historical bills',async()=>{
 const h=await mount();try{
  assert.match(h.official().textContent,/累计已用（余额核算）\$0\.30/);assert.match(h.characters().textContent,/23,541/);assert.match(h.official().textContent,/累计充值\$20\.00/);assert.match(h.official().textContent,/官方余额\$19\.70/)
  assert.doesNotMatch(h.official().textContent,/0\.174394544|0\.2385287|尚缺官方账单/)
  const query=h.calls.find(path=>path.startsWith('costs?'))!;assert.match(query,/from=2026-09-01&to=2026-09-15&timezone=UTC&provider=/)
  await h.navigate('/admin/costs');assert.match(h.w.document.querySelector('.adm-provider-funding').textContent,/\$0\.30/);assert.ok(h.calls.includes(query));assert.equal(h.official(),null)
  assert.match(h.w.document.querySelector('.adm-official-breakdown').textContent,/\$0\.19/);assert.equal(h.w.document.querySelector('.adm-local-cost-evidence').open,false)
  await h.navigate('/admin/overview');assert.match(h.official().textContent,/\$0\.30/);assert.deepEqual(h.errors,[])
 }finally{h.close()}
})
test('parent five-second usage refresh checks funds every thirty seconds; manual funding refresh is immediate',async()=>{
 let now=initialTime;const h=await mount({now:()=>now});try{
  assert.equal([...h.timers.values()].filter(timer=>timer.ms===5000).length,1)
  const count=()=>h.calls.filter(p=>p==='provider-balance').length;assert.equal(count(),1)
  now+=5000;h.run(5000);await tick();assert.equal(count(),1)
  now+=25000;h.run(5000);await tick();assert.equal(count(),2)
  h.w.document.querySelector('.adm-funding-heading button').click();await tick();assert.equal(count(),3)
  Object.defineProperty(h.w.document,'visibilityState',{value:'hidden',configurable:true});now+=30000;h.run(5000);await tick();assert.equal(count(),3)
  Object.defineProperty(h.w.document,'visibilityState',{value:'visible',configurable:true});await h.navigate('/admin/costs');const reads=count();h.run(30000);await tick();assert.equal(count(),reads+1)
  const usage=h.calls.filter(p=>p.startsWith('costs?')).length;h.run(10000);await tick();assert.equal(h.calls.filter(p=>p.startsWith('costs?')).length,usage+1)
 }finally{h.close()}
})
test('missing monthly bills or changed calendar periods never erase current account funds',async()=>{
 let now=Date.parse('2026-09-30T23:59:58Z')
 const h=await mount({mode:'component',now:()=>now,request:path=>path==='provider-balance'?fundingBalanceFixture(now):{...snapshot(path,now),enabledProviders:['deepseek'],officialBills:[]}});try{
  assert.match(h.official().textContent,/\$0\.30/);assert.doesNotMatch(h.official().textContent,/OpenAI|尚缺/);assert.match(h.characters().textContent,/2026-09-01 至 2026-09-30/)
  now+=6000;await h.refresh();assert.match(h.characters().textContent,/2026-10-01 至 2026-10-01/);assert.match(h.official().textContent,/\$0\.30/)
 }finally{h.close()}
})
test('failure retains prior funds and usage with stale labels; first-read unknown values are never zero',async()=>{
 let fail=false,now=initialTime
 const h=await mount({mode:'component',now:()=>now,request:path=>{if(fail)throw Error('synthetic offline');return path==='provider-balance'?fundingBalanceFixture(now):snapshot(path,now)}})
 try{
  fail=true;now+=30000;await h.refresh();await tick();assert.match(h.official().textContent,/\$0\.30/);assert.match(h.official().textContent,/上次核对的资金数据/);assert.match(h.characters().textContent,/保留上次数据/)
  fail=false;now+=30000;await h.refresh();await tick();assert.doesNotMatch(h.official().textContent,/offline|上次核对/);assert.doesNotMatch(h.characters().textContent,/读取失败/)
 }finally{h.close()}
 const empty=await mount({mode:'component',request:()=>{throw Error('offline')}});try{assert.match(empty.characters().textContent,/尚未取得/);assert.equal(empty.official().querySelector('.adm-cost-value'),null);assert.doesNotMatch(empty.official().textContent,/\$0/)}finally{empty.close()}
})
test('server-side auth revocation clears money even if the rendered role is still owner',async()=>{
 for(const code of ['unauthorized','admin_forbidden']){
  let failed=false
  const h=await mount({mode:'component',request:path=>{if(failed)throw Object.assign(Error('revoked'),{code});return path==='provider-balance'?fundingBalanceFixture(initialTime):snapshot(path)}})
  try{assert.match(h.official().textContent,/\$0\.30/);failed=true;await h.refresh();assert.doesNotMatch(h.official().textContent,/\$0\.30|\$20|19\.70/);assert.doesNotMatch(h.characters().textContent,/23,541/)}finally{h.close()}
 }
})
test('support and finance retain permitted usage while private funds and balance endpoints stay owner-only',async()=>{
 for(const role of ['admin','support','finance','editor']){
  const h=await mount({role});try{
   assert.equal(h.official(),null);assert.equal(Boolean(h.characters()),role!=='editor');assert.ok(!h.calls.includes('provider-balance')&&!h.calls.includes('billing-status'))
   await h.navigate('/admin/costs');assert.equal(h.w.document.querySelector('.adm-provider-funding'),null);assert.ok(!h.calls.includes('provider-balance')&&!h.calls.includes('billing-status'));assert.deepEqual(h.errors,[])
  }finally{h.close()}
 }
})
test('identity replacement rejects an old owner balance response; permission loss clears a new pending response',async()=>{
 const resolves:Array<(value:unknown)=>void>=[]
 const h=await mount({mode:'component',request:path=>path==='provider-balance'?new Promise(resolve=>resolves.push(resolve)):snapshot(path)})
 try{
  assert.equal(resolves.length,1);h.w.__setProps({identity:'new-owner'});await tick();assert.equal(resolves.length,2)
  resolves[0](fundingBalanceFixture(initialTime));await tick();assert.equal(h.official().querySelector('.adm-cost-value'),null)
  resolves[1](fundingBalanceFixture(initialTime));await tick();assert.match(h.official().textContent,/\$0\.30/)
  h.w.document.querySelector('.adm-funding-heading button').click();await tick();h.w.__setProps({officialAccess:false});await tick();resolves[2](fundingBalanceFixture(initialTime));await tick();assert.equal(h.official(),null);assert.doesNotMatch(h.body(),/19\.70/)
 }finally{h.close()}
})
test('usage refresh requests coalesce without duplicating the balance request',async()=>{
 let resolvePending!:(value:unknown)=>void,count=0,path=''
 const h=await mount({mode:'component',request:p=>{if(p==='provider-balance')return fundingBalanceFixture(initialTime);path=p;return ++count===2?new Promise(resolve=>{resolvePending=resolve}):snapshot(p)}})
 try{
  const pending=h.w.__refreshOverview();await tick();const duplicate=h.w.__refreshOverview();h.w.__refreshOverview();await tick();assert.equal(count,2)
  resolvePending(snapshot(path));await Promise.all([pending,duplicate]);await tick();assert.equal(count,3);assert.equal(h.calls.filter(p=>p==='provider-balance').length,1)
 }finally{h.close()}
})
test('unmounted overview late balances cannot overwrite the costs page or a fresh overview instance',async()=>{
 let resolveLate!:(value:unknown)=>void,hold=false
 const h=await mount({request:path=>{if(path==='provider-balance'){if(hold){hold=false;return new Promise(resolve=>{resolveLate=resolve})}return fundingBalanceFixture(initialTime)}return path.startsWith('costs?')?snapshot(path):{configured:true}}})
 try{
  hold=true;h.w.document.querySelector('.adm-funding-heading button').click();await tick();await h.navigate('/admin/costs')
  const bad=fundingBalanceFixture(initialTime);bad.funding.cumulativeTopUps='500';bad.funding.netPaidFunding='500';bad.funding.usedPaid='480.30';resolveLate(bad);await tick();assert.doesNotMatch(h.body(),/480\.30/)
  await h.navigate('/admin/overview');assert.match(h.official().textContent,/\$0\.30/);assert.deepEqual(h.errors,[])
 }finally{h.close()}
})
test('UTC rollover rejects old monthly usage response without relabeling it; cumulative funds remain unchanged',async()=>{
 let now=Date.parse('2026-09-30T23:59:58Z'),old:ReturnType<typeof snapshot>|undefined,returnOld=false
 const h=await mount({mode:'component',now:()=>now,request:path=>path==='provider-balance'?fundingBalanceFixture(now):returnOld?old:old=snapshot(path,now)})
 try{
  now+=6000;returnOld=true;await h.refresh();assert.match(h.characters().textContent,/账期数据尚未核实/);assert.match(h.characters().textContent,/2026-09-01 至 2026-09-30/);assert.match(h.official().textContent,/\$0\.30/)
  returnOld=false;await h.refresh();assert.match(h.characters().textContent,/2026-10-01 至 2026-10-01/)
 }finally{h.close()}
})


test('real funding registration requires review and explicit save, preserves exact decimals and refreshes after a confirmed mutation',async()=>{
 const mutations:any[]=[],balance=fundingBalanceFixture(initialTime)
 const h=await mount({request:(path,body)=>{if(path==='mutate'){mutations.push(body);return {funding:balance.funding}}return path==='provider-balance'?balance:path.startsWith('costs?')?snapshot(path):{configured:true}}})
 try{
  await h.navigate('/admin/costs');const reads=h.calls.filter(p=>p==='provider-balance').length
  h.w.document.querySelector('.adm-funding-confirm').click();await tick();assert.match(h.body(),/历次累计总额，不是本次金额/)
  const form=h.w.document.querySelector('.adm-edit-form'),inputs=form.querySelectorAll('input')
  inputs[0].value='20.000000000001';inputs[0].dispatchEvent(new h.w.Event('input',{bubbles:true}));inputs[2].value='synthetic funding receipt';inputs[2].dispatchEvent(new h.w.Event('input',{bubbles:true}))
  const reason=form.querySelector('textarea');reason.value='synthetic owner check';reason.dispatchEvent(new h.w.Event('input',{bubbles:true}))
  form.dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));await tick();assert.equal(mutations.length,0);assert.match(h.body(),/请核对本次修改/)
  form.dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));await tick();assert.equal(mutations.length,1)
  const op=mutations[0];assert.equal(op.action,'provider.funding.confirm');assert.equal(op.target,'deepseek');assert.equal(op.data.cumulativeTopUps,'20.000000000001');assert.equal(op.data.cumulativeCashRefunds,'0');assert.equal(op.data.balanceFetchedAt,balance.fetchedAt);assert.equal(op.data.currency,'USD');assert.equal(op.reason,'synthetic owner check');assert.match(op.operationId,/^[a-f0-9-]{36}$/)
  assert.equal(h.calls.filter(p=>p==='provider-balance').length,reads+1);assert.match(h.body(),/确认累计充值与退款已完成/);assert.equal(h.w.document.querySelector('.adm-dialog'),null)
 }finally{h.close()}
})
