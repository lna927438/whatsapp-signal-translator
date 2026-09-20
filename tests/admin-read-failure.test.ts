import {test,before} from 'node:test'
import assert from 'node:assert/strict'
import {JSDOM,VirtualConsole} from 'jsdom'
import {adminOverviewBundle} from './admin-overview-fixture.ts'
import {costsFixture,fundingBalanceFixture} from './admin-costs-fixture.ts'

let bundle:string
before(async()=>{bundle=await adminOverviewBundle()})
const tick=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setTimeout(resolve,0))}
const at='2026-09-20T15:00:00Z'
const overview=(extra:Record<string,unknown>={})=>({users:14,recentClients:2,todayCharacters:51010,pendingTranslations:3,costs:{mismatches:1},snapshotAt:at,...extra})
const page=(rows:unknown[]=[],hasMore=false)=>({rows,hasMore,snapshotAt:at})
const deferred=()=>{let resolve!:(value:any)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<any>((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}

async function mount(request:(path:string)=>unknown){
  const errors:string[]=[],console=new VirtualConsole();console.on('jsdomError',error=>errors.push(error.message))
  const dom=new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>',{url:'https://admin.example.invalid/admin/overview',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:console}),w=dom.window as any
  const timers=new Map<number,()=>void>();let timerId=0
  w.__session={id:'fixture-owner',email:'owner@example.invalid',role:'owner'}
  w.setInterval=(fn:()=>void)=>{timers.set(++timerId,fn);return timerId};w.clearInterval=(id:number)=>timers.delete(id);w.scrollTo=()=>{}
  Object.defineProperty(w.document,'visibilityState',{value:'visible',configurable:true})
  w.__request=async(path:string)=>{
    if(path==='session')return w.__session
    if(path==='provider-balance')return fundingBalanceFixture(Date.now())
    return request(path)
  }
  w.eval(bundle);await tick()
  const find=(selector:string)=>w.document.querySelector(selector)
  return {w,errors,find,body:()=>w.document.body.textContent as string,
    refresh:()=>{find('.adm-heading button').click()},
    poll:()=>{for(const fn of timers.values())fn()},
    navigate:async(path:string)=>{await w.__navigate(path);await tick()},
    close:()=>{w.__dispose();dom.window.close()}}
}
function costs(path:string){const query=new URLSearchParams(path.split('?')[1]);return costsFixture({from:query.get('from')!,to:query.get('to')!,timezone:query.get('timezone')!})}
function countTexts(h:Awaited<ReturnType<typeof mount>>){return ['.adm-overview-users strong','.adm-overview-users small','.adm-overview-today strong','.adm-status-list div:nth-child(3) dd','.adm-status-list div:nth-child(4) dd'].map(selector=>h.find(selector).textContent)}

test('initial overview failure leaves every affected counter unknown while official funds can still load',async()=>{
  const h=await mount(path=>{if(path==='overview')throw Error('管理服务暂不可用。');return costs(path)})
  try{
    assert.deepEqual(countTexts(h),['尚未取得','最近 2 分钟联机：尚未取得','尚未取得','尚未取得','尚未取得'])
    assert.match(h.find('.adm-error').textContent,/尚未取得的数据不会显示为零/)
    assert.match(h.find('.adm-overview-funding').textContent,/\$0\.30/)
    assert.equal(h.find('.adm-content-footer').textContent.includes('数据读取于'),false)
    assert.deepEqual(h.errors,[])
  }finally{h.close()}
})

test('loading never flashes a false zero, and confirmed numeric and numeric-string zero remain visible',async()=>{
  const waiting=deferred(),h=await mount(path=>path==='overview'?waiting.promise:costs(path))
  try{
    assert.ok(countTexts(h).every(text=>text.includes('读取中…')))
    waiting.resolve(overview({users:0,recentClients:'0',todayCharacters:0,pendingTranslations:'0',costs:{mismatches:0}}));await tick()
    assert.deepEqual(countTexts(h),['0','最近 2 分钟联机：0 位','0','0 条','0 条'])
    assert.equal(h.find('.adm-error'),null)
  }finally{h.close()}
})

test('missing, null, malformed and unsafe counters are never coerced to zero or NaN',async()=>{
  const h=await mount(path=>path==='overview'?overview({users:null,recentClients:'',todayCharacters:-1,pendingTranslations:true,costs:{mismatches:Number.MAX_SAFE_INTEGER+1}}):costs(path))
  try{assert.ok(countTexts(h).every(text=>text.includes('尚未取得')));assert.doesNotMatch(countTexts(h).join(' '),/NaN|0 条|0 位/)}finally{h.close()}
})

test('failed refresh retains verified values with a stale label throughout retry and clears it only after recovery',async()=>{
  let mode:'ok'|'fail'|'pending'='ok';const waiting=deferred()
  const h=await mount(path=>{if(path!=='overview')return costs(path);if(mode==='fail')throw Error('暂时不可用');return mode==='pending'?waiting.promise:overview()})
  try{
    const known=countTexts(h);mode='fail';h.refresh();await tick()
    assert.deepEqual(countTexts(h),known);assert.match(h.find('.adm-error').textContent,/保留上次数据，可能已过期.*2026-09-20/)
    mode='pending';h.refresh();await tick();assert.deepEqual(countTexts(h),known);assert.match(h.find('.adm-error').textContent,/可能已过期/)
    waiting.resolve(overview({users:15,todayCharacters:52000}));await tick();assert.equal(h.find('.adm-error'),null);assert.equal(h.find('.adm-overview-users strong').textContent,'15')
  }finally{h.close()}
})

test('slow independent billing refresh cannot hide successful overview or block its next refresh',async()=>{
  let hold=false,calls=0;const waiting=deferred()
  const h=await mount(path=>path==='overview'?(calls++,overview()):hold?waiting.promise:costs(path))
  try{
    hold=true;h.refresh();await tick();assert.equal(calls,2);assert.equal(h.find('.adm-heading button').disabled,false)
    h.poll();await tick();assert.equal(calls,3);assert.equal(h.find('.adm-overview-users strong').textContent,'14')
  }finally{h.close();waiting.resolve({})}
})

test('late overview response cannot overwrite a newer page or its snapshot',async()=>{
  const waiting=deferred(),h=await mount(path=>path==='overview'?waiting.promise:path.startsWith('costs?')?costs(path):page([{id:'u1',email:'test@example.invalid'}]))
  try{
    await h.navigate('/admin/users');assert.match(h.body(),/test@example.invalid/)
    waiting.resolve(overview({snapshotAt:'2020-01-01T00:00:00Z'}));await tick()
    assert.match(h.find('.adm-content-footer').textContent,/2026-09-20/);assert.doesNotMatch(h.body(),/2020-01-01/)
  }finally{h.close()}
})

test('switching from successful overview to failed user list never shows its timestamp or a false empty result',async()=>{
  const h=await mount(path=>{if(path==='overview')return overview();if(path.startsWith('costs?'))return costs(path);throw Error('列表暂不可用')})
  try{
    await h.navigate('/admin/users');assert.match(h.find('.adm-empty').textContent,/记录尚未取得/)
    assert.match(h.find('.adm-list-footer').textContent,/本页数据尚未取得/)
    assert.doesNotMatch(h.body(),/没有符合条件|本页 0 条|数据读取于|上次数据/)
  }finally{h.close()}
})

test('a failed new search clears previous rows instead of relabeling them as the new results',async()=>{
  const h=await mount(path=>{if(path==='overview')return overview();if(path.startsWith('costs?'))return costs(path);if(new URLSearchParams(path.split('?')[1]).get('q'))throw Error('搜索暂不可用');return page([{id:'u1',email:'previous@example.invalid'}])})
  try{
    await h.navigate('/admin/users');assert.match(h.body(),/previous@example.invalid/)
    const input=h.find('.adm-search input');input.value='new query';input.dispatchEvent(new h.w.Event('input',{bubbles:true}));h.find('.adm-toolbar').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));await tick()
    assert.doesNotMatch(h.body(),/previous@example.invalid|本页 0 条/);assert.match(h.find('.adm-empty').textContent,/记录尚未取得/)
  }finally{h.close()}
})

test('real empty user result still displays an empty table and zero rows',async()=>{
  const h=await mount(path=>path==='overview'?overview():path.startsWith('costs?')?costs(path):page())
  try{await h.navigate('/admin/users');assert.match(h.find('.adm-empty').textContent,/没有符合条件/);assert.match(h.find('.adm-list-footer').textContent,/本页 0 条/)}finally{h.close()}
})

test('authentication failure clears all prior overview values and late replies cannot restore them',async()=>{
  let fail=false;const h=await mount(path=>{if(path==='overview'){if(fail)throw new h.w.__ApiError('请重新登录','unauthorized');return overview()}return costs(path)})
  try{
    fail=true;h.refresh();await tick();assert.equal(h.find('.adm-overview-users'),null);assert.match(h.body(),/请重新登录/);assert.doesNotMatch(h.body(),/51,010|数据读取于/)
  }finally{h.close()}
})
