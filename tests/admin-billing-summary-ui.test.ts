import {test,before} from 'node:test'
import assert from 'node:assert/strict'
import {JSDOM,VirtualConsole} from 'jsdom'
import {adminOverviewBundle} from './admin-overview-fixture.ts'
import {adminCostsBundle,costsFixture,nativeMonthFixture,officialBillFixture,fundingBalanceFixture} from './admin-costs-fixture.ts'

let overviewBundle:string,costBundle:string
before(async()=>{[overviewBundle,costBundle]=await Promise.all([adminOverviewBundle('component'),adminCostsBundle()])})
const start=Date.parse('2026-09-24T02:00:00Z'),tick=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setTimeout(r,0))}
function response(path:string,now=start){
 const query=new URLSearchParams(path.split('?')[1]),full=costsFixture({from:query.get('from')!,to:query.get('to')!,timezone:query.get('timezone')!})
 full.snapshotAt=new Date(now).toISOString();if(query.get('officialCurrentMonth')==='true')nativeMonthFixture(full,now)
 full.officialBills=[officialBillFixture('deepseek','2.66',full),officialBillFixture('openai','0.05',full)]
 full.officialBills.forEach(b=>b.fetched_at=full.snapshotAt)
 const {users,days,providers,providerBalance,...rest}=full
 return path.startsWith('billing-summary?')?{...rest,totals:{charged_characters:23541,refunded_characters:0},enabledProviders:['deepseek','openai']}:full
}
type Handler=(path:string,now:number)=>unknown
async function mount(mode:'overview'|'costs',handler?:Handler,initialNow=start){
 const errors:string[]=[],console=new VirtualConsole();console.on('jsdomError',e=>errors.push(e.message));console.on('error',e=>errors.push(String(e)))
 const dom=new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>',{url:'https://admin.example.invalid/admin/'+mode,runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:console}),w=dom.window as any
 let now=initialNow,next=0;const timers=new Map<number,{fn:()=>void,ms:number}>(),calls:string[]=[]
 const RealDate=w.Date;w.Date=class extends RealDate{constructor(...args:any[]){super(...(args.length?args:[now]))}static now(){return now}}
 w.setInterval=(fn:()=>void,ms:number)=>{timers.set(++next,{fn,ms});return next};w.clearInterval=(id:number)=>timers.delete(id)
 Object.defineProperty(w.document,'visibilityState',{value:'visible',configurable:true})
 w.__request=async(path:string)=>{calls.push(path);if(handler)return handler(path,now);return path==='provider-balance'?fundingBalanceFixture(now):path==='billing-status'?{configured:true,enabledProviders:['deepseek','openai']}:response(path,now)}
 w.eval(mode==='overview'?overviewBundle:costBundle);await tick()
 const panel=()=>w.document.querySelector('.adm-usage-details')
 return {w,calls,errors,body:()=>w.document.body.textContent as string,panel,async open(){panel().open=true;panel().dispatchEvent(new w.Event('toggle'));await tick()},async run(ms=30000){now+=ms;for(const t of timers.values())if(t.ms===30000)t.fn();await tick()},async query(from:string){const input=w.document.querySelector('input[type=date]');input.value=from;input.dispatchEvent(new w.Event('input',{bubbles:true}));w.document.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick()},async refreshDetails(){w.document.querySelector('.adm-detail-toolbar button').click();await tick()},close(){w.__dispose();dom.window.close()}}
}
const summaryCount=(h:{calls:string[]})=>h.calls.filter(p=>p.startsWith('billing-summary?')).length
const detailCount=(h:{calls:string[]})=>h.calls.filter(p=>p.startsWith('costs?')).length

test('overview polls only lightweight summary and balance, never full historical receipts',async()=>{
 const h=await mount('overview');try{
  assert.match(h.body(),/23,541/);assert.match(h.body(),/\$2\.66/);assert.match(h.body(),/\$2\.71/)
  assert.match(h.body(),/未加载的明细不会显示为零/);assert.doesNotMatch(h.body(),/回执合计：\$0\.00/)
  await h.run();assert.equal(summaryCount(h),2);assert.equal(detailCount(h),0)
  assert.equal(h.calls.filter(p=>p==='provider-balance').length,2)
  assert.deepEqual(h.errors,[])
 }finally{h.close()}
})
test('costs page keeps unloaded details unknown and only first expansion reads full costs',async()=>{
 const h=await mount('costs');try{
  assert.equal(h.panel().open,false);assert.equal(detailCount(h),0);assert.match(h.body(),/展开后读取/)
  assert.doesNotMatch(h.body(),/所选期间没有请求/);assert.match(h.body(),/23,541/)
  await h.run();assert.equal(summaryCount(h),2);assert.equal(detailCount(h),0)
  await h.open();assert.equal(detailCount(h),1);assert.match(h.panel().textContent,/所选期间没有请求/)
  await h.run();h.w.dispatchEvent(new h.w.Event('online'));await tick();assert.equal(detailCount(h),1)
  h.panel().open=false;h.panel().dispatchEvent(new h.w.Event('toggle'));await tick();await h.open();assert.equal(detailCount(h),1)
  await h.refreshDetails();assert.equal(detailCount(h),2);assert.deepEqual(h.errors,[])
 }finally{h.close()}
})
test('full costs timeout remains local while official summary and balance continue refreshing',async()=>{
 let fail=true
 const h=await mount('costs',(path,now)=>path==='provider-balance'?fundingBalanceFixture(now):path==='billing-status'?{configured:true}:path.startsWith('costs?')&&fail?Promise.reject(Error('查询超时')):response(path,now));try{
  await h.open();assert.match(h.panel().textContent,/核算明细暂时无法读取.*尚未取得明细/)
  assert.equal(h.w.document.querySelectorAll('.adm-costs > .adm-error').length,0)
  assert.equal(h.w.document.querySelector('[data-provider=deepseek] .adm-official-amount').textContent,'$2.66')
  await h.run();assert.equal(summaryCount(h),2);assert.equal(detailCount(h),1);assert.equal(h.calls.filter(p=>p==='provider-balance').length,2)
  fail=false;await h.refreshDetails();assert.match(h.panel().textContent,/所选期间没有请求/)
  fail=true;await h.refreshDetails();assert.match(h.panel().textContent,/保留上次明细.*可能过期/);assert.match(h.panel().textContent,/所选期间没有请求/)
  assert.equal(h.w.document.querySelector('[data-provider=total] .adm-official-amount').textContent,'$2.71')
 }finally{h.close()}
})
test('slow full costs request coalesces and cannot overwrite a newer queried period',async()=>{
 const pending:Array<{path:string;resolve:(v:unknown)=>void}>=[]
 const h=await mount('costs',(path,now)=>path==='provider-balance'?fundingBalanceFixture(now):path==='billing-status'?{configured:true}:path.startsWith('costs?')?new Promise(resolve=>pending.push({path,resolve})):response(path,now));try{
  await h.open();await h.refreshDetails();await h.run();assert.equal(detailCount(h),1)
  await h.query('2026-08-01');assert.equal(detailCount(h),2);assert.doesNotMatch(h.panel().textContent,/所选期间没有请求/)
  const latest=response(pending[1].path) as any;latest.users=[{email:'new-period@example.invalid',charged_characters:7,known_cost_usd:0,unpriced_requests:0}]
  pending[1].resolve(latest);await tick();assert.match(h.panel().textContent,/new-period@example.invalid/)
  const old=response(pending[0].path) as any;old.users=[{email:'old-period@example.invalid'}];pending[0].resolve(old);await tick()
  assert.doesNotMatch(h.panel().textContent,/old-period@example.invalid/)
  assert.match(h.w.document.querySelector('.adm-query-period').textContent,/2026-08-01/)
 }finally{h.close()}
})
test('detail permission change invalidates pending private results and keeps official amounts hidden',async()=>{
 let finish:((v:unknown)=>void)|undefined,path=''
 const h=await mount('costs',(p,now)=>p==='provider-balance'?fundingBalanceFixture(now):p==='billing-status'?{configured:true}:p.startsWith('costs?')?(path=p,new Promise(resolve=>finish=resolve)):response(p,now));try{
  await h.open();h.w.__setAccess(false);await tick();finish!({...response(path),users:[{email:'old-owner@example.invalid'}]});await tick()
  assert.doesNotMatch(h.body(),/old-owner@example.invalid|\$2\.66/);assert.equal(h.w.document.querySelectorAll('.adm-provider-funding').length,0)
 }finally{h.close()}
})
test('overview identity change clears former balance and bills and rejects an old summary response',async()=>{
 let hold=false,finish:((v:unknown)=>void)|undefined,heldPath=''
 const h=await mount('overview',(path,now)=>path==='provider-balance'?fundingBalanceFixture(now):hold?(heldPath=path,new Promise(resolve=>finish=resolve)):response(path,now));try{
  hold=true;h.w.__refreshOverview();await tick();const old=finish!,oldPath=heldPath
  h.w.__setProps({identity:'new-owner',officialAccess:false});await tick();assert.doesNotMatch(h.body(),/\$2\.66|USD 19\.70/)
  old(response(oldPath));await tick();assert.doesNotMatch(h.body(),/\$2\.66|USD 19\.70/)
 }finally{h.close()}
})

test('detail auth revocation invalidates a concurrent summary so old private amounts cannot return',async()=>{
 let hold=false,finish:((v:unknown)=>void)|undefined,path=''
 const h=await mount('costs',(p,now)=>p==='provider-balance'?fundingBalanceFixture(now):p==='billing-status'?{configured:true}:p.startsWith('costs?')?Promise.reject({code:'unauthorized'}):hold?(path=p,new Promise(resolve=>finish=resolve)):response(p,now));try{
  hold=true;await h.run();assert.equal(typeof finish,'function')
  await h.open();assert.doesNotMatch(h.body(),/\$2\.66|\$19\.70/)
  finish!(response(path));await tick();assert.doesNotMatch(h.body(),/\$2\.66|\$19\.70/)
  assert.equal(h.w.document.querySelector('.adm-character-total b').textContent,'尚未取得')
 }finally{h.close()}
})
test('known zero characters stays zero while a failed first summary is unknown',async()=>{
 for(const failed of [false,true]){
  const h=await mount('costs',(path,now)=>path==='provider-balance'?fundingBalanceFixture(now):path==='billing-status'?{configured:true}:failed?Promise.reject(Error('摘要暂不可用')):{...response(path,now),totals:{charged_characters:0,refunded_characters:0}})
  try{assert.equal(h.w.document.querySelector('.adm-character-total b').textContent,failed?'尚未取得':'0');assert.equal(detailCount(h),0)}finally{h.close()}
 }
})

test('a provider statement read failure remains local to that card while totals and the other bill remain usable',async()=>{
 for(const mode of ['overview','costs'] as const){
  const h=await mount(mode,(path,now)=>{
   if(path==='provider-balance')return fundingBalanceFixture(now)
   if(path==='billing-status')return {configured:true}
   const value=response(path,now)
   return {...value,officialBills:value.officialBills.filter(b=>b.provider==='openai'),officialBillReadErrors:{deepseek:'unavailable'}}
  });try{
   const deepseek=h.w.document.querySelector('[data-provider=deepseek]'),openai=h.w.document.querySelector('[data-provider=openai]')
   assert.match(deepseek.textContent,/账单暂未取得.*读取暂时失败/s)
   assert.equal(openai.querySelector('.adm-official-amount').textContent,'$0.05')
   assert.match(h.body(),/23,541/);assert.match(h.body(),/账单未齐全/)
   assert.doesNotMatch(deepseek.textContent,/请核对并录入所选账期金额|\$0\.00/)
  }finally{h.close()}
 }
})

test('GMT+8 following current month uses its own date across midnight and month rollover',async()=>{
 const h=await mount('costs',undefined,Date.parse('2026-09-30T17:00:00Z'))
 try{
  const select=h.w.document.querySelector('select');select.value='Asia/Shanghai';select.dispatchEvent(new h.w.Event('change',{bubbles:true}));await tick()
  h.w.document.querySelector('form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));await tick()
  const query=new URLSearchParams(h.calls.filter(p=>p.startsWith('billing-summary?')).at(-1)!.split('?')[1])
  assert.equal(query.get('from'),'2026-10-01');assert.equal(query.get('to'),'2026-10-01');assert.equal(query.get('timezone'),'Asia/Shanghai')
  assert.match(h.w.document.querySelector('.adm-query-period').textContent,/2026-10-01 至 2026-10-01 · GMT\+8/)
 }finally{h.close()}
})

test('missing or malformed charged totals cannot be displayed as a known zero',async()=>{
 for(const charged of [undefined,null,'',-1,'invalid']){
  const h=await mount('costs',(path,now)=>path==='provider-balance'?fundingBalanceFixture(now):path==='billing-status'?{configured:true}:{...response(path,now),totals:{charged_characters:charged}})
  try{assert.equal(h.w.document.querySelector('.adm-character-total b').textContent,'尚未取得')}finally{h.close()}
 }
})
