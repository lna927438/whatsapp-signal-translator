import {test,before} from 'node:test'
import assert from 'node:assert/strict'
import {JSDOM} from 'jsdom'
import {currencyAmount} from '../website/src/admin/money.ts'
import {parseProviderBalance,balanceState,utcTimestamp} from '../website/src/admin/providerBalance.ts'
import {adminCostsBundle,balanceFixture,costsFixture} from './admin-costs-fixture.ts'

let bundle:string;before(async()=>{bundle=await adminCostsBundle()})
const tick=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setTimeout(resolve,0))}
async function mount(options:{access?:boolean;request?:(path:string,body?:unknown)=>unknown}={}) {
  const dom=new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>',{url:'https://admin.example.invalid/admin/costs',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window as any,calls:string[]=[],timers=new Map<number,{fn:()=>void;ms:number}>();let timerId=0
  w.__officialAccess=options.access!==false
  w.setInterval=(fn:()=>void,ms:number)=>{timers.set(++timerId,{fn,ms});return timerId};w.clearInterval=(id:number)=>timers.delete(id)
  Object.defineProperty(w.document,'visibilityState',{value:'visible',configurable:true})
  w.__request=async(path:string,body?:unknown)=>{calls.push(path);return options.request?options.request(path,body):path.startsWith('costs?')?costsFixture():path==='provider-balance'?balanceFixture():{configured:true,message:'已同步'}}
  w.eval(bundle);await tick()
  return {dom,w,calls,timers,body:()=>w.document.body.textContent as string,run:(ms:number)=>{for(const item of timers.values())if(item.ms===ms)item.fn()},close:()=>{w.__dispose();dom.window.close()}}
}
test('official USD/CNY amounts retain every decimal digit and reject numeric or invented currencies',()=>{
  assert.equal(currencyAmount('999999999999.999999999999','USD'),'USD 999,999,999,999.999999999999')
  assert.equal(currencyAmount('-0.000000000001','CNY'),'CNY -0.000000000001')
  assert.equal(currencyAmount('0','USD'),'USD 0.00');assert.equal(currencyAmount(1.23,'USD'),'待核对');assert.equal(currencyAmount('1','EUR'),'待核对')
  const value=balanceFixture();assert.deepEqual(parseProviderBalance(value).balances,value.balances)
  assert.throws(()=>parseProviderBalance({...value,balances:[{...value.balances[0],total:1.2}]}),/不完整/)
  assert.throws(()=>parseProviderBalance({...value,balances:[value.balances[0],value.balances[0]]}),/不完整/)
})
test('freshness uses provider fetched time rather than a new checked time, with UTC explicit',()=>{
  const now=Date.parse('2026-09-15T12:00:00Z'),value=balanceFixture(now-121000);value.checkedAt=new Date(now).toISOString()
  assert.equal(balanceState(parseProviderBalance(value),'',now).delayed,true)
  assert.equal(utcTimestamp(value.fetchedAt),'2026-09-15 11:57:59 UTC')
  assert.match(balanceState(parseProviderBalance(value),'network',now).label,/保留上次/)
})
test('one visible balance card shows precise currencies, amount details and current data without summary fallback',async()=>{
  const h=await mount();try{
    assert.equal(h.w.document.querySelectorAll('.adm-provider-funding').length,1)
    assert.match(h.body(),/USD 1,234\.123456789012/);assert.match(h.body(),/CNY 0\.000000000009/)
    assert.match(h.body(),/赠金余额 USD 0\.000000000001/);assert.doesNotMatch(h.body(),/999999999999/)
    assert.match(h.body(),/\$0\.123456789012/);assert.match(h.body(),/23,541/);assert.match(h.body(),/UTC/)
    assert.equal(h.calls.filter(p=>p==='provider-balance').length,1)
  }finally{h.close()}
})
test('30-second visible checks and the manual button share one guarded request and do not overwrite it with the cost snapshot',async()=>{
  let resolveBalance:((value:unknown)=>void)|undefined,balanceCalls=0
  const h=await mount({request:path=>path.startsWith('costs?')?costsFixture():path==='provider-balance'?(balanceCalls++,new Promise(resolve=>{resolveBalance=resolve})):{configured:true}})
  try{
    h.run(30000);h.w.document.querySelector('.adm-funding-heading button').click();await tick();assert.equal(balanceCalls,1)
    assert.equal(h.w.document.querySelector('.adm-funding-heading button').disabled,true)
    resolveBalance!(balanceFixture());await tick();assert.match(h.body(),/USD 1,234\.123456789012/)
    h.run(10000);await tick();assert.match(h.body(),/USD 1,234\.123456789012/);assert.doesNotMatch(h.body(),/999999999999/)
    Object.defineProperty(h.w.document,'visibilityState',{value:'hidden',configurable:true});h.run(30000);await tick();assert.equal(balanceCalls,1)
    Object.defineProperty(h.w.document,'visibilityState',{value:'visible',configurable:true});h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));await tick();assert.equal(balanceCalls,2)
    resolveBalance!(balanceFixture());await tick()
  }finally{h.close()}
})
test('a failed refresh retains the sampled amount and time, then reconnect recovers without a zero placeholder',async()=>{
  let fail=false;const sampled=balanceFixture(Date.parse('2026-09-15T01:00:00Z'))
  const h=await mount({request:path=>path.startsWith('costs?')?costsFixture():path==='provider-balance'?fail?Promise.reject(Error('暂时无法连接')):sampled:{configured:true}})
  try{
    fail=true;h.w.document.querySelector('.adm-funding-heading button').click();await tick();assert.match(h.body(),/上次核对的资金数据/);assert.match(h.body(),/2026-09-15 01:00:00 UTC/);assert.match(h.body(),/USD 1,234\.123456789012/)
    fail=false;sampled.balances[0].total='1234.000000000001';sampled.fetchedAt=new Date().toISOString();h.w.dispatchEvent(new h.w.Event('online'));await tick();assert.match(h.body(),/USD 1,234\.000000000001/);assert.doesNotMatch(h.body(),/暂时无法连接/)
  }finally{h.close()}
})
test('explicit absent account data clears old balance and a role change cannot receive an in-flight private balance',async()=>{
  let response:any=balanceFixture(),resolveBalance:((value:unknown)=>void)|undefined
  const h=await mount({request:path=>path.startsWith('costs?')?costsFixture():path==='provider-balance'?response:{configured:true}})
  try{
    response={...balanceFixture(),available:null,balances:[],fetchedAt:null,snapshotAt:null,sync:{...balanceFixture().sync,status:'not_configured'}}
    h.w.document.querySelector('.adm-funding-heading button').click();await tick();assert.match(h.body(),/尚未连接/);assert.match(h.body(),/尚未取得/);assert.doesNotMatch(h.body(),/USD 1,234/)
    response=new Promise(resolve=>{resolveBalance=resolve});h.run(30000);await tick();h.w.__setAccess(false);await tick();resolveBalance!(balanceFixture());await tick();assert.equal(h.w.document.querySelectorAll('.adm-provider-funding').length,0);assert.doesNotMatch(h.body(),/USD 1,234/)
  }finally{h.close()}
})
test('cost-reader roles make no owner-only balance or official-bill requests',async()=>{
  const h=await mount({access:false});try{h.run(30000);await tick();assert.ok(h.calls.every(path=>path.startsWith('costs?')));assert.equal(h.w.document.querySelectorAll('.adm-provider-funding').length,0);assert.doesNotMatch(h.body(),/同步官方账单/)}finally{h.close()}
})
test('background cost refresh preserves the submitted filter until Query is pressed',async()=>{
  const h=await mount();try{
    const input=h.w.document.querySelector('input[type=date]');input.value='2026-01-01';input.dispatchEvent(new h.w.Event('input',{bubbles:true}));await tick()
    const previous=h.calls.filter(p=>p.startsWith('costs?')).at(-1);h.run(10000);await tick();assert.equal(h.calls.filter(p=>p.startsWith('costs?')).at(-1),previous)
    h.w.document.querySelector('form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));await tick();assert.match(h.calls.filter(p=>p.startsWith('costs?')).at(-1)!,/from=2026-01-01/)
  }finally{h.close()}
})
