import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {adminOverviewBundle} from './admin-overview-fixture.ts'
import {costsFixture,fundingBalanceFixture,nativeMonthFixture,officialBillFixture} from './admin-costs-fixture.ts'

const {chromium}=createRequire(import.meta.url)('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const directory=fileURLToPath(new URL('../verification/admin-timeout-20260924/browser-funding/',import.meta.url))
await mkdir(directory,{recursive:true})
const bundle=await adminOverviewBundle(),now=Date.now(),data=nativeMonthFixture(costsFixture(),now)
Object.assign(data,{enabledProviders:['deepseek','openai'],translationProviders:['deepseek'],defaultTranslationProvider:'deepseek'})
data.officialBills=[officialBillFixture('deepseek','2.66',data),officialBillFixture('openai','0.051080427',data)]
data.officialBills.forEach(bill=>bill.fetched_at=new Date(now).toISOString())
const browser=await chromium.launch({channel:'msedge',headless:true}),checks=[],errors=[],network=[]
try{
 for(const section of ['overview','costs']){
  const context=await browser.newContext({viewport:{width:1440,height:1100},locale:'zh-CN'})
  const page=await context.newPage();page.setDefaultTimeout(10000)
  page.on('pageerror',error=>errors.push({section,message:error.message}))
  await page.route('**/*',route=>{network.push(route.request().url());return route.abort()})
  await page.setContent('<!doctype html><html lang="zh-CN"><body style="margin:0"><div id="app"></div></body></html>')
  await page.evaluate(({data,balance,now,section})=>{
   window.__route='/admin/'+section;window.__data=data;window.__balance=balance;window.__now=now
   window.__session={id:'fixture-owner-a',email:'a@example.invalid',role:'owner'}
   window.__calls=[];window.__pendingBalances=[];window.__holdBalance=false;window.__balanceFailure=false;window.__badSnapshot=false;window.__overviewFailure=false
   const RealDate=Date
   window.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[window.__now]))}static now(){return window.__now}}
   const timers=new Map();let timerId=0
   window.setInterval=(fn,ms)=>{timers.set(++timerId,{fn,ms,nextAt:window.__now+ms});return timerId}
   window.clearInterval=id=>timers.delete(id)
   window.__tick=delta=>{
    window.__now+=delta
    for(const timer of [...timers.values()])if(window.__now>=timer.nextAt){timer.nextAt=window.__now+timer.ms;timer.fn()}
   }
   window.__setMoney=(paid,used,topups='20')=>{
    window.__balance.balances=[{currency:'USD',total:paid,paid,granted:'0'}]
    Object.assign(window.__balance.funding,{cumulativeTopUps:topups,cumulativeCashRefunds:'0',netPaidFunding:topups,paidBalance:paid,grantedBalance:'0',usedPaid:used})
   }
   window.__setMoney('16.874321098766','3.125678901234')
   window.__request=async(path,body)=>{
    window.__calls.push({path,hasBody:body!==undefined,identity:window.__session.id})
    if(path==='session')return structuredClone(window.__session)
    if(path==='overview'){if(window.__overviewFailure)throw Error('合成总览服务暂不可用');return {users:14,recentClients:2,todayCharacters:100,pendingTranslations:0,snapshotAt:new Date().toISOString(),costs:{mismatches:0}}}
    if(path.startsWith('billing-summary?')){
     const result=structuredClone(window.__data)
     result.totals={charged_characters:result.totals.charged_characters,refunded_characters:result.totals.refunded_characters}
     for(const key of ['providers','users','days','providerBalance'])delete result[key]
     return result
    }
    if(path==='billing-status')return {configured:true,enabledProviders:['deepseek','openai'],sync:{status:'fresh'}}
    if(path==='provider-balance'){
     if(window.__balanceFailure)throw Error('合成线路暂时中断')
     const value=structuredClone(window.__balance),timestamp=new Date().toISOString()
     Object.assign(value,{fetchedAt:timestamp,snapshotAt:timestamp,checkedAt:timestamp})
     value.sync.nextRefreshAt=new Date(window.__now+30000).toISOString()
     value.funding.balanceFetchedAt=window.__badSnapshot?new Date(window.__now-1000).toISOString():timestamp
     if(window.__holdBalance)return new Promise(resolve=>window.__pendingBalances.push(()=>resolve(value)))
     return value
    }
    throw Error('Unexpected synthetic route: '+path)
   }
   window.__releaseBalance=()=>{const resolve=window.__pendingBalances.shift();if(!resolve)throw Error('No pending synthetic balance');resolve()}
  },{data,balance:fundingBalanceFixture(now),now,section})
  await page.addScriptTag({content:bundle})
  const funding=page.locator(section==='overview'?'.adm-overview-funding':'.adm-account-funding .adm-provider-funding')
  const monthly=name=>page.locator(section==='overview'?(name==='total'?'.adm-overview-cost':`.adm-overview-provider[data-provider="${name}"]`):`.adm-provider-cost-card[data-provider="${name}"]`)
  const used=funding.locator('.adm-funding-used .adm-cost-value'),balance=funding.locator('.adm-funding-balance strong')
  const balanceCalls=()=>page.evaluate(()=>window.__calls.filter(call=>call.path==='provider-balance').length)
  const settle=()=>page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)))
  const assertMonth=async()=>{
   assert.equal(await monthly('deepseek').locator('.adm-official-amount').innerText(),'$2.66')
   assert.equal(await monthly('openai').locator('.adm-official-amount').innerText(),'$0.05')
   assert.equal(await monthly('total').locator('.adm-official-amount').innerText(),'$2.71')
   assert.equal(await monthly('total').locator('.adm-official-amount').getAttribute('title'),'2.711080427')
   assert.match(await monthly('deepseek').innerText(),/手工录入/)
   assert.doesNotMatch(await monthly('deepseek').innerText(),/官方导出|官方账单手动导入/)
  }
  await used.filter({hasText:'$3.12'}).waitFor()
  assert.equal(await used.innerText(),'$3.12');assert.equal(await used.getAttribute('title'),'3.125678901234')
  assert.equal(await balance.innerText(),'$16.87');assert.equal(await balance.getAttribute('title'),'16.874321098766')
  assert.equal(await funding.locator('xpath=ancestor::details[not(@open)]').count(),0,'Cumulative money must be visible without opening details')
  assert.match(await funding.innerText(),/累计充值消耗/)
  await assertMonth()
  const monthBefore=await monthly('deepseek').locator('.adm-bill-updated').innerText()
  assert.equal(await balanceCalls(),1)
  for(const width of [1440,960,480]){
   await page.setViewportSize({width,height:1100});assert.equal(await funding.isVisible(),true)
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal overflow: '+section+' '+width)
   const placement=await funding.evaluate(element=>({top:element.getBoundingClientRect().top,month:document.querySelector('.adm-overview-cost-grid,.adm-provider-costs').getBoundingClientRect().top}))
   assert.ok(placement.top<placement.month,'Automatic cumulative funds precede month statements')
   await page.screenshot({path:directory+'/'+section+'-'+width+'.png',fullPage:true})
  }
  await page.setViewportSize({width:1440,height:1100})
  await page.evaluate(()=>{window.__setMoney('16.863456789012','3.136543210988');window.__tick(29999)})
  await settle();assert.equal(await balanceCalls(),1,'No early provider balance polling')
  await page.evaluate(()=>window.__tick(1))
  await used.filter({hasText:'$3.13'}).waitFor()
  assert.equal(await balanceCalls(),2,'One official balance snapshot at the 30 second boundary')
  assert.equal(await used.getAttribute('title'),'3.136543210988');assert.equal(await balance.getAttribute('title'),'16.863456789012')
  await assertMonth();assert.equal(await monthly('deepseek').locator('.adm-bill-updated').innerText(),monthBefore)
  checks.push({section,automaticCumulativePrimary:true,sameSnapshotExactAmounts:true,manualMonthUnchanged:'2.66',monthlyTotalExact:'2.711080427',intervalMilliseconds:30000})

  if(section==='overview'){
   const countBefore=await page.evaluate(()=>({balance:window.__calls.filter(call=>call.path==='provider-balance').length,
    overview:window.__calls.filter(call=>call.path==='overview').length,summary:window.__calls.filter(call=>call.path.startsWith('billing-summary?')).length}))
   await page.evaluate(()=>window.__overviewFailure=true)
   for(let iteration=1;iteration<=8;iteration++){
    await page.evaluate(()=>window.__tick(30000))
    await page.waitForFunction(expected=>window.__calls.filter(call=>call.path==='provider-balance').length===expected,countBefore.balance+iteration)
    await settle()
   }
   const delta=await page.evaluate(before=>({balance:window.__calls.filter(call=>call.path==='provider-balance').length-before.balance,
    overview:window.__calls.filter(call=>call.path==='overview').length-before.overview,
    summary:window.__calls.filter(call=>call.path.startsWith('billing-summary?')).length-before.summary}),countBefore)
   assert.equal(delta.balance,8,'Overview failures must not delay independent official balance reads')
   assert.ok(delta.overview>=2&&delta.overview<8,'Overview actually uses failure backoff in this regression')
   assert.equal(delta.summary,8,'Lightweight monthly characters and official statements retain their own 30-second refresh despite parent overview failure')
   assert.equal(await page.evaluate(()=>window.__calls.some(call=>call.path.startsWith('costs?'))),false,'No full historical receipt query may be polled')
   await assertMonth();await page.evaluate(()=>window.__overviewFailure=false)
   checks.push({section,overviewFailureDoesNotDelayBalance:true,consecutiveBalanceIntervals:8,parentOverviewReads:delta.overview,billingSummaryReads:delta.summary,automaticFullCostReads:0})
  }

  await page.evaluate(()=>{window.__holdBalance=true;window.__setMoney('15.432109876544','4.567890123456');window.__tick(30000)})
  await page.waitForFunction(()=>window.__pendingBalances.length===1)
  const pendingCount=await balanceCalls()
  for(let index=0;index<3;index++)await page.evaluate(()=>{window.__tick(30000);window.dispatchEvent(new Event('online'));document.dispatchEvent(new Event('visibilitychange'))})
  await settle();assert.equal(await balanceCalls(),pendingCount,'Timer and resume events cannot overlap the in-flight official balance request')
  assert.equal(await funding.locator('.adm-funding-heading button').isDisabled(),true)
  await page.evaluate(()=>{window.__holdBalance=false;window.__releaseBalance()})
  await used.filter({hasText:'$4.56'}).waitFor();await assertMonth()
  checks.push({section,pendingBalanceCoalesced:true})

  await page.evaluate(()=>{window.__balanceFailure=true;window.__tick(30000)})
  await funding.getByText('同步未完成或有延迟，保留上次资金数据；当前金额可能过期。',{exact:true}).waitFor()
  assert.equal(await used.innerText(),'$4.56');assert.equal(await balance.getAttribute('title'),'15.432109876544');await assertMonth()
  const failedCount=await balanceCalls()
  await page.screenshot({path:directory+'/'+section+'-stale.png',fullPage:true})
  await page.evaluate(()=>window.__tick(30000));await settle();assert.equal(await balanceCalls(),failedCount,'A failure backs off instead of increasing polling')
  await page.evaluate(()=>{window.__balanceFailure=false;window.__setMoney('15.30','4.70');window.__tick(30000)})
  await used.filter({hasText:'$4.70'}).waitFor();assert.equal(await balanceCalls(),failedCount+1)
  assert.equal(await funding.locator('.adm-balance-state.delayed').count(),0);await assertMonth()
  checks.push({section,failureKeepsPreviousAmountAndMarksStale:true,retryBackoffMilliseconds:60000})

  await page.evaluate(()=>{window.__badSnapshot=true;window.__setMoney('14','6');window.__tick(30000)})
  await funding.getByText('累计资金数据未通过核对，保留上次结果。',{exact:true}).waitFor()
  assert.equal(await used.innerText(),'$4.70');assert.equal(await balance.getAttribute('title'),'15.30');await assertMonth()
  checks.push({section,mismatchedSnapshotRejectedAtomically:true})

  await page.evaluate(()=>{window.__badSnapshot=false;window.__holdBalance=true;window.__setMoney('13','7');window.__tick(60000)})
  await page.waitForFunction(()=>window.__pendingBalances.length===1)
  await page.evaluate(()=>{
   window.__session={id:'fixture-owner-b',email:'b@example.invalid',role:'owner'}
   window.__data.officialBills=[];window.__setMoney('38.50','1.50','40');window.__remount()
  })
  await page.waitForFunction(()=>window.__pendingBalances.length===2)
  assert.equal(await used.count(),0,'Old identity cumulative amount is removed while new balance is pending')
  assert.equal(await monthly('deepseek').locator('.adm-official-amount').innerText(),'待同步官方账单')
  await page.evaluate(()=>window.__releaseBalance());await settle()
  assert.equal(await used.count(),0,'The prior account late response cannot restore its amounts')
  await page.evaluate(()=>{window.__holdBalance=false;window.__releaseBalance()})
  await used.filter({hasText:'$1.50'}).waitFor()
  assert.equal(await balance.innerText(),'$38.50')
  assert.equal(await funding.locator('.adm-funding-topups strong').innerText(),'$40.00')
  assert.doesNotMatch(await funding.innerText(),/\$7\.00|\$4\.70/)
  checks.push({section,identityChangeClearsMoneyAndRejectsLateReply:true})
  assert.equal(await page.evaluate(()=>window.__calls.some(call=>call.hasBody)),false,'Read-only verification must not submit mutations')
  assert.equal(await page.evaluate(()=>window.__calls.some(call=>call.path.startsWith('costs?'))),false,'Collapsed receipts stay unloaded through all automatic and manual headline refreshes')
  await page.evaluate(()=>window.__dispose());await context.close()
 }
 assert.deepEqual(errors,[]);assert.deepEqual(network,[])
 const report={passed:true,at:new Date().toISOString(),syntheticOnly:true,production:false,liveAccountAccess:false,externalNetworkRequests:0,pageErrors:errors,checks,directory}
 await writeFile(directory+'/results.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))
}finally{await browser.close()}
