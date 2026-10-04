import {test,before} from 'node:test'
import assert from 'node:assert/strict'
import {JSDOM} from 'jsdom'
import {parseProviderBalance} from '../website/src/admin/providerBalance.ts'
import {fundingDecimal} from '../website/src/admin/providerFunding.ts'
import {adminCostsBundle,fundingBalanceFixture,costsFixture} from './admin-costs-fixture.ts'

test('confirmed 20 USD funding and 19.70 official balance yields exact 0.30; true zero remains distinct from missing',()=>{
 const data=fundingBalanceFixture();assert.equal(parseProviderBalance(data).funding?.usedPaid,'0.30')
 data.funding.usedPaid='0';data.funding.paidBalance='20';data.balances[0].paid='20';data.balances[0].total='20';assert.equal(parseProviderBalance(data).funding?.usedPaid,'0')
 assert.equal(parseProviderBalance({...data,funding:undefined}).funding,null)
 assert.equal(fundingDecimal('0.3'),fundingDecimal('0.1')!+fundingDecimal('0.2')!)
 assert.equal(fundingDecimal(0.3),null);assert.equal(fundingDecimal('1e-3'),null)
})
test('tiny exact expense, gifts and cash refunds are separate and funding amounts must reconcile',()=>{
 const data=fundingBalanceFixture()
 Object.assign(data.funding,{cumulativeCashRefunds:'1',netPaidFunding:'19',paidBalance:'18.999999999999',grantedBalance:'2',usedPaid:'0.000000000001'})
 data.balances[0]={currency:'USD',total:'20.999999999999',paid:'18.999999999999',granted:'2'}
 assert.equal(parseProviderBalance(data).funding?.usedPaid,'0.000000000001')
 for(const patch of [{usedPaid:'0.000000000002'},{paidBalance:'19'},{netPaidFunding:'20'},{cumulativeCashRefunds:'0'},{grantedBalance:'0'},{usedPaid:0.000000000001}])assert.throws(()=>parseProviderBalance({...data,funding:{...data.funding,...patch}}),/未通过核对/)
})
test('account basis, snapshot mismatch, future confirmation, negative expense and unconfirmed claimed expense are rejected',()=>{
 const data=fundingBalanceFixture()
 for(const patch of [{scope:'all_accounts'},{basis:'statement'},{currency:'CNY'},{balanceFetchedAt:new Date(Date.now()-30000).toISOString()},{confirmedAt:new Date(Date.now()+120000).toISOString()},{basisSource:null},{usedPaid:'-0.3'},{status:'needs_confirmation'}])assert.throws(()=>parseProviderBalance({...data,funding:{...data.funding,...patch}}),/未通过核对/)
 const changed={...data,funding:{...data.funding,status:'needs_confirmation',usedPaid:null,reason:'balance_increased'}}
 assert.equal(parseProviderBalance(changed).funding?.usedPaid,null)
 assert.equal(parseProviderBalance({...data,funding:{...data.funding,status:'stale'}}).funding?.usedPaid,'0.30')
})

let bundle:string;before(async()=>{bundle=await adminCostsBundle()})
const tick=async()=>{for(let i=0;i<6;i++)await new Promise(resolve=>setTimeout(resolve,0))}
async function mount(read:(path:string)=>unknown){
 const dom=new JSDOM('<div id="app"></div>',{url:'https://admin.example.invalid/admin/costs',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window as any,calls:string[]=[],timers=new Map<number,()=>void>();let id=0
 w.setInterval=(fn:()=>void)=>{timers.set(++id,fn);return id};w.clearInterval=(i:number)=>timers.delete(i);w.__request=async(path:string)=>{calls.push(path);return read(path)}
 Object.defineProperty(w.document,'visibilityState',{value:'visible',configurable:true});w.eval(bundle);await tick()
 return {w,calls,text:()=>w.document.querySelector('.adm-provider-funding').textContent as string,refresh:async()=>{w.document.querySelector('.adm-funding-heading button').click();await tick()},close:()=>{w.__dispose();dom.window.close()}}
}
test('real funds card retains 0.30 across missing period bills and changing filters, with explicit registration only',async()=>{
 const data=fundingBalanceFixture(),h=await mount(path=>path==='provider-balance'?data:path.startsWith('billing-summary?')?{...costsFixture(),enabledProviders:['deepseek']}:{enabledProviders:['deepseek'],configured:false})
 try{
  assert.match(h.text(),/累计充值消耗\$0\.30/);assert.match(h.text(),/累计充值\$20\.00/);assert.match(h.text(),/官方余额\$19\.70/);assert.doesNotMatch(h.text(),/尚缺官方账单/)
  assert.equal(h.w.__funding,undefined);assert.ok(!h.calls.includes('mutate'))
  const date=h.w.document.querySelector('input[type=date]');date.value='2020-01-01';date.dispatchEvent(new h.w.Event('input',{bubbles:true}));h.w.document.querySelector('form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));await tick();assert.match(h.text(),/\$0\.30/)
  h.w.document.querySelector('.adm-funding-confirm').click();await tick();assert.deepEqual(JSON.parse(JSON.stringify(h.w.__funding)),{currency:'USD',cumulativeTopUps:'20',cumulativeCashRefunds:'0',balanceFetchedAt:data.fetchedAt,reference:''});assert.ok(!h.calls.includes('mutate'))
 }finally{h.close()}
})
test('failed or inconsistent refresh keeps last verified amount visibly stale, and recovery updates exact used',async()=>{
 let data:any=fundingBalanceFixture(),fail=false
 const h=await mount(path=>{if(path==='provider-balance'){if(fail)throw Error('synthetic offline');return data}return path.startsWith('billing-summary?')?costsFixture():{configured:true}})
 try{
  fail=true;await h.refresh();assert.match(h.text(),/\$0\.30/);assert.match(h.text(),/保留上次资金数据.*可能过期/);assert.equal(h.w.document.querySelector('.adm-funding-confirm').disabled,true)
  fail=false;data={...data,funding:{...data.funding,usedPaid:'99'}};await h.refresh();assert.match(h.text(),/未通过核对/);assert.doesNotMatch(h.text(),/\$99/)
  data=fundingBalanceFixture();data.funding.paidBalance='19.69';data.funding.usedPaid='0.31';data.balances[0].paid='19.69';data.balances[0].total='19.69';await h.refresh();assert.match(h.text(),/\$0\.31/);assert.doesNotMatch(h.text(),/可能过期|offline|未通过核对/)
 }finally{h.close()}
})
test('unconfirmed balance increases hide used rather than inventing spend; revoked access clears previous money',async()=>{
 let data:any=fundingBalanceFixture(),denied=false
 const h=await mount(path=>{if(path==='provider-balance'){if(denied)throw Object.assign(Error('access revoked'),{code:'admin_forbidden'});return data}return path.startsWith('billing-summary?')?costsFixture():{configured:true}})
 try{
  data.funding={...data.funding,status:'needs_confirmation',reason:'balance_increased',usedPaid:null};data.balances[0].total='39.70';data.balances[0].paid='39.70';await h.refresh();assert.match(h.text(),/待确认累计充值/);assert.match(h.text(),/\$39\.70/);assert.doesNotMatch(h.text(),/\$0\.30/)
  denied=true;await h.refresh();assert.doesNotMatch(h.text(),/\$39\.70|\$20/)
 }finally{h.close()}
})

test('a revoked costs read clears old funds and invalidates a late pending balance reply',async()=>{
 let failCosts=false,holdBalance=false,resolveLate!:(value:unknown)=>void
 const h=await mount(path=>{if(path==='provider-balance')return holdBalance?new Promise(resolve=>{resolveLate=resolve}):fundingBalanceFixture();if(path.startsWith('billing-summary?')){if(failCosts)throw Object.assign(Error('forbidden'),{code:'admin_forbidden'});return costsFixture()}return {configured:true}})
 try{
  assert.match(h.text(),/\$0\.30/);holdBalance=true;await h.refresh()
  failCosts=true;h.w.document.querySelector('form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));await tick();assert.doesNotMatch(h.text(),/\$0\.30|\$20|19\.70/)
  resolveLate(fundingBalanceFixture());await tick();assert.doesNotMatch(h.text(),/\$0\.30|\$20|19\.70/)
 }finally{h.close()}
})

