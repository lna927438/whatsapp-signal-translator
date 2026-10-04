import {test,before} from 'node:test'
import assert from 'node:assert/strict'
import {JSDOM} from 'jsdom'
import {currentBillPeriod,officialBillSummary,sumOfficialAmounts,type BillPeriod} from '../website/src/admin/officialBills.ts'
import {adminCostsBundle,balanceFixture,costsFixture,officialBillFixture,costsQueryFixture} from './admin-costs-fixture.ts'
const period:BillPeriod={from:'2026-09-01',to:'2026-09-15',timezone:'UTC',provider:''}
function fixture(selected=period){const data=costsFixture(selected);data.officialBills=[officialBillFixture('openai','0.0329117',data),officialBillFixture('deepseek','0.000000000009',data)];return data}
test('official totals add exact decimal strings, including zero and credits, without Number rounding',()=>{
  assert.equal(sumOfficialAmounts(['999999999.999999999999','0.000000000001']),'1000000000')
  assert.equal(sumOfficialAmounts(['0.0329117','0.000000000009']),'0.032911700009')
  assert.equal(sumOfficialAmounts(['0.1','0.2','-0.3']),'0')
  assert.equal(sumOfficialAmounts(['-0.000000000001','0']),'-0.000000000001')
  for(const invalid of [0.1,'1e-12','NaN','0.0000000000001',null,undefined])assert.equal(sumOfficialAmounts(['1',invalid]),null)
  assert.equal(sumOfficialAmounts([]),null)
})
test('complete official total requires all selected providers, and an actual zero snapshot is different from missing',()=>{
  const data=fixture();assert.equal(officialBillSummary(data,period).total,'0.032911700009')
  data.officialBills.pop();assert.deepEqual(officialBillSummary(data,period).missing,['deepseek']);assert.equal(officialBillSummary(data,period).total,null);assert.equal(officialBillSummary(data,period).partial,'0.0329117')
  data.officialBills[0].official_usd_exact='0';assert.equal(officialBillSummary(data,period).partial,'0');assert.equal(officialBillSummary(data,period).complete,false)
  data.officialBills.push(officialBillFixture('deepseek','0',data));assert.equal(officialBillSummary(data,period).total,'0');assert.equal(officialBillSummary(data,period).complete,true)
  assert.equal(officialBillSummary({...data,officialBills:[]},period).partial,null)
})
test('provider filtering never combines the unselected provider or local token estimates',()=>{
  const data=fixture()
  assert.equal(officialBillSummary(data,{...period,provider:'openai'}).total,'0.0329117')
  assert.equal(officialBillSummary(data,{...period,provider:'deepseek'}).total,'0.000000000009')
  data.officialBills[0].official_usd_exact=undefined;assert.equal(officialBillSummary(data,{...period,provider:'openai'}).total,null)
})

test('enabled provider metadata excludes retired bills from current totals and never treats disabled or invalid configuration as zero',()=>{
 const data=Object.assign(fixture(),{enabledProviders:['deepseek']})
 assert.equal(officialBillSummary(data,period).total,'0.000000000009');assert.deepEqual(officialBillSummary(data,period).missing,[])
 const historical=officialBillSummary(data,{...period,provider:'openai'});assert.equal(historical.total,null);assert.equal(historical.complete,false);assert.deepEqual(historical.missing,[])
 for(const enabledProviders of [[],null,['invalid'],['deepseek','deepseek']]){
  const value=officialBillSummary({...data,enabledProviders},period);assert.equal(value.total,null);assert.equal(value.complete,false);assert.deepEqual(value.items,[])
 }
})
test('native provider boundaries use the same calendar dates; business timezone and nearby periods cannot relabel an official bill',()=>{
  const china={...period,timezone:'Asia/Shanghai'},data=fixture(china)
  assert.equal(data.from,'2026-08-31T16:00:00.000Z');assert.equal(data.toExclusive,'2026-09-15T16:00:00.000Z')
  assert.equal(data.officialBills[0].period_from,'2026-09-01T00:00:00.000Z');assert.equal(data.officialBills[1].period_from,'2026-08-31T16:00:00.000Z')
  assert.equal(officialBillSummary(data,china).complete,true)
  assert.equal(officialBillSummary(data,period).partial,null)
  data.officialBills[0].period_from='2026-08-31T16:00:00Z';assert.deepEqual(officialBillSummary(data,china).missing,['openai'])
  data.officialBills[1].timezone='UTC';assert.equal(officialBillSummary(data,china).partial,null)
  assert.equal(officialBillSummary(fixture(),{...period,to:'2026-09-14'}).partial,null)
  assert.equal(officialBillSummary(fixture(),{...period,from:'2026-02-30'}).partial,null)
  const equivalent=fixture();equivalent.officialBills[0].period_from='2026-09-01T00:00:00+00:00';assert.equal(officialBillSummary(equivalent,period).complete,true)
  const wrongBasis=fixture();wrongBasis.officialBillingBasis.from='2026-08-01';assert.equal(officialBillSummary(wrongBasis,period).partial,null)
  const wrongZone=fixture();wrongZone.officialBillingBasis.timezones.deepseek='UTC';assert.equal(officialBillSummary(wrongZone,period).partial,null)
})
test('old account, unverified scope, incomplete period, wrong currency, duplicates or missing timestamps never become official totals',()=>{
  for(const field of ['currentAccount','periodComplete','currency','fetched_at']){
    const data=fixture();delete data.officialBills[0][field];assert.deepEqual(officialBillSummary(data,period).missing,['openai'])
  }
  for(const changes of [{currentAccount:false},{periodComplete:false},{currency:'CNY'},{fetched_at:'yesterday'},{source:'local_estimate'}]){
    const data=fixture();Object.assign(data.officialBills[0],changes);assert.deepEqual(officialBillSummary(data,period).missing,['openai'])
  }
  const duplicate=fixture();duplicate.officialBills.push({...duplicate.officialBills[0]});assert.equal(officialBillSummary(duplicate,period).total,null)
})

let bundle:string;before(async()=>{bundle=await adminCostsBundle()})
const tick=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setTimeout(resolve,0))}
async function mount(options:{access?:boolean;now?:()=>number;request?:(path:string,body?:unknown)=>unknown}={}){
  const dom=new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>',{url:'https://admin.example.invalid/admin/costs',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window as any,calls:string[]=[],timers=new Map<number,{fn:()=>void;ms:number}>();let timerId=0
  let localNow=Date.now();const now=options.now||(()=>localNow),RealDate=w.Date;w.Date=class extends RealDate{constructor(...args:any[]){super(...(args.length?args:[now()]))}static now(){return now()}}
  w.__officialAccess=options.access!==false;w.setInterval=(fn:()=>void,ms:number)=>{timers.set(++timerId,{fn,ms});return timerId};w.clearInterval=(id:number)=>timers.delete(id)
  Object.defineProperty(w.document,'visibilityState',{value:'visible',configurable:true})
  w.__request=async(path:string,body?:unknown)=>{calls.push(path);const result=await (options.request?options.request(path,body):/^(costs|billing-summary)\?/.test(path)?costsFixture():path==='provider-balance'?balanceFixture():{configured:true,message:'已同步'});return /^(costs|billing-summary)\?/.test(path)?costsQueryFixture(path,result as ReturnType<typeof costsFixture>,now()):result}
  w.eval(bundle);await tick()
  return {w,calls,card:()=>w.document.querySelector('.adm-official-breakdown'),body:()=>w.document.body.textContent as string,run:(ms:number)=>{localNow+=ms;for(const item of timers.values())if(item.ms===ms)item.fn()},close:()=>{w.__dispose();dom.window.close()}}
}
test('historical breakdown retains each provider bill and missing-period labels, with local evidence collapsed',async()=>{
  const data=costsFixture();data.officialBills=[officialBillFixture('openai','0.0329117',data)]
  const h=await mount({request:path=>/^(costs|billing-summary)\?/.test(path)?data:path==='provider-balance'?balanceFixture():{configured:true}})
  try{
    assert.match(h.card().textContent,/尚未同步该账期/);assert.match(h.card().textContent,/\$0\.03/);assert.match(h.card().textContent,/DeepSeek/)
    assert.doesNotMatch(h.card().textContent,/0\.123456789012|987654321/)
    const details=h.w.document.querySelector('.adm-usage-details')
    assert.equal(details.open,false);assert.match(details.textContent,/明细尚未加载/)
    details.open=true;details.dispatchEvent(new h.w.Event('toggle'));await tick();assert.match(details.textContent,/\$0\.12/)
    assert.match(h.body(),/官方 Costs API 快照/);assert.match(h.body(),/不能直接分摊为每位用户的翻译费用/)
    data.officialBills.push(officialBillFixture('deepseek','0.000000000009',data));h.run(30000);await tick()
    assert.match(h.card().textContent,/\$0\.03/);assert.doesNotMatch(h.card().textContent,/尚未同步该账期/);assert.match(h.body(),/手工录入/)
    data.officialBills=[];h.run(30000);await tick();assert.match(h.card().textContent,/尚未同步该账期/);assert.doesNotMatch(h.card().textContent,/\$0\.03/)
  }finally{h.close()}
})

test('official bills exclusively drive headline cards; changing receipt estimates cannot replace them',async()=>{
 const data=costsFixture();data.totals.known_cost_usd_exact='1.62';data.totals.unpriced_requests=536
 data.providers=[{provider:'deepseek',known_cost_usd_exact:'1.59',unpriced_requests:466},{provider:'openai',known_cost_usd_exact:'0.03',unpriced_requests:57}] as any
 const h=await mount({request:path=>/^(costs|billing-summary)\?/.test(path)?data:path==='provider-balance'?balanceFixture():{configured:true}})
 try{
  const card=(name:string)=>h.w.document.querySelector(`.adm-provider-cost-card[data-provider="${name}"]`)
  const amount=(name:string)=>card(name).querySelector('.adm-provider-amount').textContent
  const official=(name:string)=>card(name).querySelector('.adm-official-amount').textContent
  assert.equal(amount('deepseek'),'待同步官方账单');assert.equal(amount('openai'),'待同步官方账单');assert.equal(amount('total'),'账单未齐全')
  assert.equal(official('deepseek'),'待同步官方账单');assert.equal(official('total'),'账单未齐全')
  assert.match(card('total').querySelector('.adm-fee-label').textContent,/已保存账期记录合计/)
  assert.doesNotMatch(card('total').textContent,/费用记录不完整|尚未归属/)
  const details=h.w.document.querySelector('.adm-usage-details');assert.match(details.textContent,/明细尚未加载/)
  details.open=true;details.dispatchEvent(new h.w.Event('toggle'));await tick();assert.match(details.textContent,/536 条费用记录不完整|13 条历史记录尚未归属通道/)
  assert.doesNotMatch(h.body(),/次调用待核算/)
  data.officialBills=[officialBillFixture('deepseek','1.658919574',data)];h.run(30000);await tick()
  assert.equal(official('deepseek'),'$1.65');assert.equal(official('total'),'账单未齐全');assert.match(card('total').textContent,/待同步 OpenAI/);assert.doesNotMatch(card('total').textContent,/\$1\.66/)
  data.officialBills.push(officialBillFixture('openai','0.05',data));h.run(30000);await tick()
  assert.equal(official('openai'),'$0.05');assert.equal(official('total'),'$1.71');assert.equal(card('deepseek').querySelector('.adm-official-amount').title,'1.658919574')
  assert.equal(amount('total'),'$1.71')
  assert.match(card('deepseek').textContent,/GMT\+8/);assert.match(card('openai').textContent,/UTC/)
  data.officialBills[0].currentAccount=false;h.run(30000);await tick()
  assert.equal(official('deepseek'),'待同步官方账单');assert.equal(official('total'),'账单未齐全');assert.doesNotMatch(card('total').textContent,/已同步部分/)
 }finally{h.close()}
})

test('DeepSeek-only configuration hides retired OpenAI billing warnings and actions while preserving explicit historical receipts',async()=>{
 const h=await mount({request:path=>{
  if(path==='provider-balance')return balanceFixture()
  if(path==='billing-status')return {enabledProviders:['deepseek'],configured:false,reason:'provider_disabled',message:'OpenAI official sync not configured',sync:{status:'error',message:'OpenAI account deactivated'}}
  const query=new URLSearchParams(path.split('?')[1]),data=Object.assign(costsFixture({from:query.get('from')!,to:query.get('to')!,timezone:query.get('timezone')!}),{enabledProviders:['deepseek']})
  data.officialBills=[officialBillFixture('openai','100',data),officialBillFixture('deepseek','0.19',data)];return data
 }})
 try{
  assert.match(h.card().textContent,/DeepSeek/);assert.match(h.card().textContent,/\$0\.19/);assert.doesNotMatch(h.card().textContent,/OpenAI|100|尚缺/)
  const breakdown=h.w.document.querySelector('.adm-official-breakdown');assert.doesNotMatch(breakdown.textContent,/OpenAI|deactivated|not configured|同步官方账单/)
  assert.equal(breakdown.querySelectorAll('.adm-bill-provider').length,1)
  const provider=h.w.document.querySelectorAll('select')[1];assert.match(provider.textContent,/OpenAI（历史）/)
  provider.value='openai';provider.dispatchEvent(new h.w.Event('change',{bubbles:true}));h.w.document.querySelector('form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));await tick()
  assert.equal(h.card(),null);assert.match(h.w.document.querySelector('.adm-retired-provider').textContent,/此通道已停用/)
  const details=h.w.document.querySelector('.adm-usage-details');details.open=true;details.dispatchEvent(new h.w.Event('toggle'));await tick()
  assert.match(details.textContent,/OpenAI 回执/);assert.ok(!h.calls.includes('billing-sync'))
 }finally{h.close()}
})
test('official sync refreshes historical bill details immediately even when a background read is already in flight',async()=>{
  let resolveSync!:(value:unknown)=>void,resolveRead!:(value:unknown)=>void,count=0
  const old=costsFixture();old.officialBills=[officialBillFixture('openai','0.1',old)]
  const updated=costsFixture();updated.officialBills=[officialBillFixture('openai','0.2',updated),officialBillFixture('deepseek','0.000000000001',updated)]
  const h=await mount({request:path=>/^(costs|billing-summary)\?/.test(path)?(++count===1?old:count===2?new Promise(resolve=>{resolveRead=resolve}):updated):path==='billing-sync'?new Promise(resolve=>{resolveSync=resolve}):path==='provider-balance'?balanceFixture():{configured:true}})
  try{
    const button=[...h.w.document.querySelectorAll('button')].find((button:any)=>button.textContent==='同步官方账单') as HTMLButtonElement
    button.click();await tick();h.run(30000);await tick();resolveSync({message:'已同步'});await tick();resolveRead(old);await tick()
    assert.equal(count,3);assert.match(h.card().textContent,/\$0\.20/);assert.doesNotMatch(h.card().textContent,/尚未同步该账期/)
  }finally{h.close()}
})
test('default current-month queries follow UTC midnight and month rollover; manually chosen periods stay fixed',async()=>{
  let now=Date.parse('2026-09-30T23:59:58Z')
  assert.deepEqual(currentBillPeriod('Asia/Shanghai',now),{from:'2026-10-01',to:'2026-10-01'})
  const h=await mount({now:()=>now});try{
    assert.match(h.calls.find(path=>/^(costs|billing-summary)\?/.test(path))!,/from=2026-09-01&to=2026-09-30/)
    const timezone=h.w.document.querySelectorAll('select')[0];timezone.value='Asia/Shanghai';timezone.dispatchEvent(new h.w.Event('change',{bubbles:true}));h.w.document.querySelector('form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));await tick()
    assert.match(h.calls.filter(path=>/^(costs|billing-summary)\?/.test(path)).at(-1)!,/from=2026-10-01&to=2026-10-01/,'Following current month must use the submitted business timezone')
    now=Date.parse('2026-10-01T00:00:33Z');h.run(30000);await tick();assert.match(h.calls.filter(path=>/^(costs|billing-summary)\?/.test(path)).at(-1)!,/from=2026-10-01&to=2026-10-01/)
    const inputs=h.w.document.querySelectorAll('input[type=date]');inputs[0].value='2026-08-01';inputs[0].dispatchEvent(new h.w.Event('input',{bubbles:true}));inputs[1].value='2026-08-31';inputs[1].dispatchEvent(new h.w.Event('input',{bubbles:true}))
    h.w.document.querySelector('form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));await tick()
    now=Date.parse('2026-10-02T00:00:03Z');h.run(30000);await tick();assert.match(h.calls.filter(path=>/^(costs|billing-summary)\?/.test(path)).at(-1)!,/from=2026-08-01&to=2026-08-31/)
  }finally{h.close()}
})

test('unsubmitted historical filters survive month rollover while displayed bills keep their submitted current-month basis',async()=>{
 let now=Date.parse('2026-09-30T23:59:58Z'),fail=false
 const h=await mount({now:()=>now,request:path=>{
  if(!/^(costs|billing-summary)\?/.test(path))return path==='provider-balance'?balanceFixture(now):{configured:true}
  if(fail)throw Error('synthetic query failure')
  const query=new URLSearchParams(path.split('?')[1]),data=costsFixture({from:query.get('from')!,to:query.get('to')!,timezone:query.get('timezone')!})
  data.snapshotAt=new Date(now).toISOString();data.officialBills=[officialBillFixture('deepseek','0.1',data),officialBillFixture('openai','0.2',data)];data.officialBills.forEach(bill=>bill.fetched_at=data.snapshotAt);return data
 }})
 try{
  const inputs=h.w.document.querySelectorAll('input[type=date]'),selects=h.w.document.querySelectorAll('select'),form=h.w.document.querySelector('form')
  inputs[0].value='2026-08-01';inputs[0].dispatchEvent(new h.w.Event('input',{bubbles:true}));inputs[1].value='2026-08-31';inputs[1].dispatchEvent(new h.w.Event('input',{bubbles:true}))
  selects[0].value='Asia/Shanghai';selects[0].dispatchEvent(new h.w.Event('change',{bubbles:true}));selects[1].value='deepseek';selects[1].dispatchEvent(new h.w.Event('change',{bubbles:true}));await tick()
  now+=33000;h.run(30000);await tick()
  const current=h.calls.filter(path=>/^(costs|billing-summary)\?/.test(path)).at(-1)!
  assert.match(current,/from=2026-10-01&to=2026-10-01&provider=&timezone=UTC&officialCurrentMonth=true/)
  assert.match(h.w.document.querySelector('.adm-query-period').textContent,/2026-10-01 至 2026-10-01 · UTC · 全部通道 · 本月/)
  assert.equal(h.w.document.querySelector('[data-provider="total"] .adm-provider-amount').textContent,'$0.30')
  assert.equal(inputs[0].value,'2026-08-01');assert.equal(inputs[1].value,'2026-08-31');assert.equal(selects[0].value,'Asia/Shanghai');assert.equal(selects[1].value,'deepseek')
  fail=true;form.dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));await tick()
  assert.match(h.w.document.querySelector('.adm-query-period').textContent,/本月/,'A failed custom query must retain the successful bill basis')
  fail=false;now+=90000;h.run(30000);await tick();assert.equal(h.calls.filter(path=>/^(costs|billing-summary)\?/.test(path)).at(-1),current)
  form.dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));await tick()
  const historical=h.calls.filter(path=>/^(costs|billing-summary)\?/.test(path)).at(-1)!
  assert.match(historical,/from=2026-08-01&to=2026-08-31&provider=deepseek&timezone=Asia%2FShanghai/);assert.doesNotMatch(historical,/officialCurrentMonth/)
  assert.doesNotMatch(h.w.document.querySelector('.adm-query-period').textContent,/本月/)
  now+=33000;h.run(30000);await tick();assert.equal(h.calls.filter(path=>/^(costs|billing-summary)\?/.test(path)).at(-1),historical)
 }finally{h.close()}
})

test('current-month official cards and import actions use each supplier month; failed midnight reads never relabel the old bill',async()=>{
 let now=Date.parse('2026-09-30T15:59:58Z'),fail=false
 const h=await mount({now:()=>now,request:path=>{
  if(!/^(costs|billing-summary)\?/.test(path))return path==='provider-balance'?balanceFixture(now):{configured:true}
  if(fail)throw Error('synthetic midnight outage')
  const query=new URLSearchParams(path.split('?')[1]),data=costsFixture({from:query.get('from')!,to:query.get('to')!,timezone:query.get('timezone')!})
  data.snapshotAt=new Date(now).toISOString();data.officialBills=[officialBillFixture('deepseek','1.854140974',data),officialBillFixture('openai','0.0134932',data)];data.officialBills.forEach(item=>item.fetched_at=data.snapshotAt);return data
 }})
 try{
  const card=(name:string)=>h.w.document.querySelector(`[data-provider="${name}"]`)
  assert.match(h.calls.find(path=>/^(costs|billing-summary)\?/.test(path))!,/officialCurrentMonth=true/)
  assert.equal(card('deepseek').querySelector('.adm-provider-amount').textContent,'$1.85')
  now+=33000;fail=true;h.run(30000);await tick()
  assert.match(card('deepseek').querySelector('.adm-bill-period').textContent,/2026-09-01 至 2026-09-30/)
  assert.equal(card('deepseek').querySelector('.adm-provider-amount').textContent,'$1.85')
  fail=false;h.w.document.querySelector('form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));await tick()
  assert.match(card('deepseek').querySelector('.adm-bill-period').textContent,/2026-10-01 至 2026-10-01/)
  assert.match(card('openai').querySelector('.adm-bill-period').textContent,/2026-09-01 至 2026-09-30/)
  const ds=[...h.w.document.querySelectorAll('.adm-bill-provider')].find((node:any)=>node.querySelector('h3').textContent==='DeepSeek') as HTMLElement
  ds.querySelector('button')!.click();await tick()
  assert.deepEqual(JSON.parse(JSON.stringify(h.w.__reconciled)),{provider:'deepseek',from:'2026-10-01',to:'2026-10-01',timezone:'Asia/Shanghai'})
 }finally{h.close()}
})
test('OpenAI current-day sync delay remains visible after GMT+8 midnight under a GMT+8 business filter',async()=>{
  const now=Date.parse('2026-09-15T16:30:00Z')
  const h=await mount({now:()=>now,request:path=>{
    if(!/^(costs|billing-summary)\?/.test(path))return path==='provider-balance'?balanceFixture(now):{configured:true}
    const query=new URLSearchParams(path.split('?')[1]),data=costsFixture({from:query.get('from')!,to:query.get('to')!,timezone:query.get('timezone')!});data.snapshotAt=new Date(now).toISOString();data.officialBills=[officialBillFixture('openai','0.2',data),officialBillFixture('deepseek','0.3',data)];data.officialBills.forEach(bill=>{bill.fetched_at=new Date(now-11*60000).toISOString()});return data
  }})
  try{
    const timezone=h.w.document.querySelectorAll('select')[0];timezone.value='Asia/Shanghai';timezone.dispatchEvent(new h.w.Event('change',{bubbles:true}));h.w.document.querySelector('form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));await tick()
    assert.match(h.card().textContent,/\$0\.20/);assert.match(h.card().textContent,/官方同步有延迟/);assert.match(h.calls.filter(path=>/^(costs|billing-summary)\?/.test(path)).at(-1)!,/to=2026-09-16/)
  }finally{h.close()}
})
test('future samples are rejected, and an old current-period API snapshot is visibly delayed rather than called current',async()=>{
  const data=costsFixture();data.officialBills=[officialBillFixture('openai','0.2',data),officialBillFixture('deepseek','0.3',data)]
  const selected={from:data.from.slice(0,10),to:new Date(Date.parse(data.toExclusive)-86400000).toISOString().slice(0,10),timezone:'UTC',provider:''}
  data.officialBills[0].fetched_at=new Date(Date.now()+120000).toISOString();assert.equal(officialBillSummary(data,selected).total,null)
  data.officialBills[0].fetched_at=data.snapshotAt;assert.equal(officialBillSummary(data,selected,Date.now()-86400000).total,'0.5','Use the server snapshot clock when the local computer clock is behind')
  data.officialBills[0].fetched_at=new Date(Date.now()-11*60000).toISOString()
  const h=await mount({request:path=>/^(costs|billing-summary)\?/.test(path)?data:path==='provider-balance'?balanceFixture():{configured:true}})
  try{assert.match(h.card().textContent,/\$0\.20/);assert.match(h.card().textContent,/官方同步有延迟/);assert.match(h.card().textContent,/采集于/)}finally{h.close()}
})
test('provider query updates historical bill details only after that query succeeds and excludes other channels',async()=>{
  const data=costsFixture();data.officialBills=[officialBillFixture('openai','0.0329117',data),officialBillFixture('deepseek','0.000000000009',data)]
  const h=await mount({request:path=>/^(costs|billing-summary)\?/.test(path)?data:path==='provider-balance'?balanceFixture():{configured:true}})
  try{
    const select=h.w.document.querySelectorAll('select')[1];select.value='deepseek';select.dispatchEvent(new h.w.Event('change',{bubbles:true}));await tick()
    assert.match(h.card().textContent,/\$0\.03/)
    h.w.document.querySelector('form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));await tick();assert.match(h.card().textContent,/\$0\.00/);assert.doesNotMatch(h.card().textContent,/OpenAI \+ DeepSeek/)
    const total=h.w.document.querySelector('.adm-total-cost');assert.equal(total.querySelector('.adm-provider-amount').textContent,'请选全部通道查看合计');assert.doesNotMatch(total.textContent,/待同步 OpenAI|账单未齐全|已同步部分/);assert.match(h.w.document.querySelector('.adm-query-period').textContent,/DeepSeek/)
  }finally{h.close()}
})
test('non-owner cannot see official billing cards or fetch owner endpoints, including after an access change',async()=>{
  const data=costsFixture();data.officialBills=[officialBillFixture('openai','18.1',data),officialBillFixture('deepseek','18.2',data)]
  const h=await mount({access:false,request:path=>/^(costs|billing-summary)\?/.test(path)?data:{configured:true}})
  try{assert.equal(h.card(),null);assert.doesNotMatch(h.body(),/官方账单明细|\$36\.30/);assert.ok(h.calls.every(path=>/^(costs|billing-summary)\?/.test(path)))}finally{h.close()}
  const owner=await mount({request:path=>/^(costs|billing-summary)\?/.test(path)?data:path==='provider-balance'?balanceFixture():{configured:true}})
  try{assert.match(owner.card().textContent,/\$18\.10/);owner.w.__setAccess(false);await tick();assert.equal(owner.card(),null);assert.doesNotMatch(owner.body(),/\$18\.10/)}finally{owner.close()}
})
test('business GMT+8 filtering does not disable native UTC sync or change each platform manual billing timezone',async()=>{
  const h=await mount({request:path=>{
    if(/^(costs|billing-summary)\?/.test(path)){const query=new URLSearchParams(path.split('?')[1]);return costsFixture({from:query.get('from')!,to:query.get('to')!,timezone:query.get('timezone')!})}
    return path==='provider-balance'?balanceFixture():{configured:true}
  }})
  try{
    const select=h.w.document.querySelectorAll('select')[0];select.value='Asia/Shanghai';select.dispatchEvent(new h.w.Event('change',{bubbles:true}))
    h.w.document.querySelector('form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));await tick()
    const sync=[...h.w.document.querySelectorAll('button')].find((button:any)=>button.textContent==='同步官方账单') as HTMLButtonElement;assert.equal(sync.disabled,false)
    const manual=[...h.w.document.querySelectorAll('button')].filter((button:any)=>button.textContent==='录入账单核对') as HTMLButtonElement[]
    manual[0].click();await tick();assert.equal(h.w.__reconciled.timezone,'UTC');manual[1].click();await tick();assert.equal(h.w.__reconciled.timezone,'Asia/Shanghai')
    assert.match(h.body(),/实际时间边界不同/);assert.doesNotMatch(h.body(),/切换为 UTC 后/)
  }finally{h.close()}
})

test('a failed manual sync clears only after a newer matching OpenAI API snapshot, not a DeepSeek balance or statement update',async()=>{
  let now=Date.now()
  const data=costsFixture();data.snapshotAt=new Date(now).toISOString();data.officialBills=[officialBillFixture('openai','0.2',data),officialBillFixture('deepseek','0.19',data)];data.officialBills.forEach(b=>{b.fetched_at=new Date(now-5000).toISOString()})
  const h=await mount({now:()=>now,request:path=>{if(path==='billing-sync')throw Error('unavailable');return /^(costs|billing-summary)\?/.test(path)?structuredClone(data):path==='provider-balance'?balanceFixture(now):{configured:true,sync:{status:'fresh'}}}})
  try{
    const button=[...h.w.document.querySelectorAll('button')].find((b:any)=>b.textContent==='同步官方账单') as HTMLButtonElement
    button.click();await tick();assert.match(h.body(),/同步未完成，已保留上次结果/)
    now+=30000;data.snapshotAt=new Date(now).toISOString();data.officialBills[1].fetched_at=new Date(now).toISOString();h.run(30000);await tick()
    assert.match(h.body(),/同步未完成，已保留上次结果/)
    now+=30000;data.snapshotAt=new Date(now).toISOString();data.officialBills[0].fetched_at=new Date(now).toISOString();h.run(30000);await tick()
    assert.doesNotMatch(h.body(),/同步未完成，已保留上次结果/);assert.match(h.body(),/OpenAI 官方账单已恢复同步/)
    assert.match(h.card().textContent,/\$0\.20/)
  }finally{h.close()}
})

test('account-deactivation status is explicit and an automatic successful status read removes it',async()=>{
  let now=Date.now(),failed=true
  const data=costsFixture();data.snapshotAt=new Date(now).toISOString();data.officialBills=[officialBillFixture('openai','0.2',data),officialBillFixture('deepseek','0.19',data)]
  const h=await mount({now:()=>now,request:path=>/^(costs|billing-summary)\?/.test(path)?data:path==='provider-balance'?balanceFixture(now):{configured:true,sync:failed?{status:'error',errorCode:'billing_account_deactivated',message:'OpenAI 账单账号已停用，请通过官方支持恢复账号。保留上次金额。'}:{status:'fresh'}}})
  try{
    assert.match(h.card().textContent,/账单账号已停用/);assert.match(h.card().textContent,/\$0\.20/)
    failed=false;now+=61000;h.run(30000);await tick();assert.doesNotMatch(h.body(),/账单账号已停用/)
  }finally{h.close()}
})

test('a missing OpenAI billing connection is actionable beside the live fee without substituting the fee for its official bill',async()=>{
 const h=await mount({request:path=>/^(costs|billing-summary)\?/.test(path)?costsFixture():path==='provider-balance'?balanceFixture():{configured:false,message:'official API not configured'}})
 try{
  const card=h.w.document.querySelector('[data-provider="openai"]')
  assert.equal(card.querySelector('.adm-provider-amount').textContent,'待同步官方账单')
  assert.equal(card.querySelector('.adm-official-amount').textContent,'待同步官方账单')
  assert.match(card.textContent,/官方账单未接通，请由主管理员配置账单读取凭据/)
  assert.equal([...h.w.document.querySelectorAll('button')].find((button:any)=>button.textContent==='同步官方账单').disabled,true)
 }finally{h.close()}
})

test('late failed manual sync cannot restore status or text after official-access changes',async()=>{
  let rejectSync!:(error:Error)=>void
  const h=await mount({request:path=>path==='billing-sync'?new Promise((_,reject)=>{rejectSync=reject}):/^(costs|billing-summary)\?/.test(path)?costsFixture():path==='provider-balance'?balanceFixture():{configured:true}})
  try{
    const button=[...h.w.document.querySelectorAll('button')].find((b:any)=>b.textContent==='同步官方账单') as HTMLButtonElement
    button.click();await tick();h.w.__setAccess(false);await tick();rejectSync(new Error('old-account-error'));await tick();h.w.__setAccess(true);await tick()
    assert.doesNotMatch(h.body(),/old-account-error|同步未完成，已保留上次结果/)
    const sync=[...h.w.document.querySelectorAll('button')].find((b:any)=>b.textContent==='同步官方账单') as HTMLButtonElement;assert.equal(sync.disabled,false)
  }finally{h.close()}
})
