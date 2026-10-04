import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {adminOverviewBundle} from './admin-overview-fixture.ts'
import {costsFixture,fundingBalanceFixture,officialBillFixture,nativeMonthFixture} from './admin-costs-fixture.ts'
const {chromium}=createRequire(import.meta.url)('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const directory=fileURLToPath(new URL('../verification/admin-timeout-20260924/browser-headlines/',import.meta.url))
await mkdir(directory,{recursive:true})
const bundle=await adminOverviewBundle('app'),data=costsFixture()
Object.assign(data,{enabledProviders:['deepseek','openai'],translationProviders:['deepseek'],defaultTranslationProvider:'deepseek',translationModels:{deepseek:{model:'deepseek-v4-pro',displayName:'deepseek-v4-pro'},openai:{model:'gpt-5.6-luna',displayName:'gpt-5.6-luna'}}})
Object.assign(data.totals,{known_cost_usd_exact:'1.620000000001',unpriced_requests:536,provider_requests:1083,total_tokens:300000})
data.providers=[{provider:'deepseek',known_cost_usd_exact:'1.59',unpriced_requests:466,requests:1000,total_tokens:290000},{provider:'openai',known_cost_usd_exact:'0.030000000001',unpriced_requests:57,requests:70,total_tokens:10000},{provider:null,known_cost_usd_exact:'0',unpriced_requests:13,requests:13,total_tokens:null}]
const deepseek=officialBillFixture('deepseek','1.658919574',data),openai=officialBillFixture('openai','0.051080427',data)
const browser=await chromium.launch({channel:'msedge',headless:true}),errors=[],network=[],checks=[]
try{
 const page=await browser.newPage({viewport:{width:1440,height:1100},locale:'zh-CN'})
 page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>{network.push(route.request().url());return route.abort()})
 await page.setContent('<!doctype html><html lang="zh-CN"><body style="margin:0"><div id="app"></div></body></html>')
 await page.evaluate(({data,balance,nativeBasis})=>{
  window.__data=data;window.__balance=balance;window.__session={id:'fixture-owner',email:'owner@example.invalid',role:'owner'};window.__calls=[]
  window.__request=async path=>{
   window.__calls.push(path)
   if(path.startsWith('costs?'))return structuredClone(window.__data)
   if(path.startsWith('billing-summary?')){
    const result=structuredClone(window.__data)
    result.totals={charged_characters:result.totals.charged_characters,refunded_characters:result.totals.refunded_characters}
    for(const key of ['providers','users','days','providerBalance'])delete result[key]
    if(new URLSearchParams(path.split('?')[1]).get('officialCurrentMonth')==='true'){
     result.officialBillingBasis=nativeBasis
     for(const bill of result.officialBills){const period=nativeBasis.periods[bill.provider],offset=bill.provider==='deepseek'?28800000:0;bill.period_from=new Date(Date.parse(period.from+'T00:00:00Z')-offset).toISOString();bill.period_to=new Date(Date.parse(period.to+'T00:00:00Z')+86400000-offset).toISOString()}
    }
    return result
   }
   return path==='session'?window.__session:path==='overview'?{users:20,recentClients:10,todayCharacters:100,snapshotAt:new Date().toISOString()}:path==='provider-balance'?structuredClone(window.__balance):{configured:false,enabledProviders:['deepseek','openai'],message:'合成官方账单状态'}
  }
 },{data,balance:fundingBalanceFixture(),nativeBasis:nativeMonthFixture(structuredClone(data),Date.parse(data.snapshotAt)).officialBillingBasis})
 await page.addScriptTag({content:bundle})
 const overview=name=>page.locator(name==='total'?'.adm-overview-cost':`.adm-overview-provider[data-provider="${name}"]`)
 const costs=name=>page.locator(`.adm-provider-cost-card[data-provider="${name}"]`)
 await overview('deepseek').locator('.adm-official-amount').getByText('待同步官方账单',{exact:true}).waitFor()
 assert.equal(await overview('openai').locator('.adm-official-amount').innerText(),'待同步官方账单')
 assert.equal(await overview('total').locator('.adm-official-amount').innerText(),'账单未齐全')
 assert.doesNotMatch(await overview('total').innerText(),/历史记录/);assert.match(await page.locator('.adm-receipt-details').textContent(),/历史回执核算按需读取，未加载的明细不会显示为零/)
 assert.equal(await overview('deepseek').locator('strong').innerText(),'待同步官方账单')
 assert.equal(await page.evaluate(()=>window.__calls.some(path=>path.startsWith('costs?'))),false)
 checks.push('Overview reads only lightweight characters and saved official bills; receipt costs are not requested or displayed as zero')
 await page.screenshot({path:directory+'/overview-missing-bills.png',fullPage:true})
 await page.evaluate(bill=>{window.__data.officialBills=[bill]},deepseek)
 await page.getByRole('button',{name:/刷新数据/}).click()
 await overview('deepseek').locator('.adm-official-amount').getByText('$1.65',{exact:true}).waitFor()
 assert.equal(await overview('deepseek').locator('.adm-official-amount').getAttribute('title'),'1.658919574')
 assert.match(await overview('deepseek').locator('.adm-bill-updated').innerText(),/手工录入于 .* UTC/)
 assert.doesNotMatch(await overview('deepseek').innerText(),/官方导出|官方账单手动导入/)
 assert.equal(await overview('openai').locator('.adm-official-amount').innerText(),'待同步官方账单')
 assert.match(await overview('total').innerText(),/待同步 OpenAI/);assert.doesNotMatch(await overview('total').innerText(),/\$1\.66/)
 checks.push('Imported DeepSeek exact 1.658919574 displays official truncation 1.65; missing OpenAI prevents an official total or differently rounded partial total')
 for(const width of [1440,960,480]){
  await page.setViewportSize({width,height:1100})
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Overview overflow at '+width)
  await page.screenshot({path:directory+'/overview-partial-'+width+'.png',fullPage:true})
  const heavyBefore=await page.evaluate(()=>window.__calls.filter(path=>path.startsWith('costs?')).length)
  await page.evaluate(()=>window.__navigate('/admin/costs'))
  await costs('deepseek').locator('.adm-official-amount').getByText('$1.65',{exact:true}).waitFor()
  assert.equal(await costs('deepseek').locator('.adm-official-amount').getAttribute('title'),'1.658919574')
  assert.match(await costs('deepseek').locator('.adm-bill-updated').innerText(),/手工录入于 .* UTC/)
  assert.doesNotMatch(await costs('deepseek').innerText(),/官方导出|官方账单手动导入/)
  assert.equal(await costs('total').locator('.adm-official-amount').innerText(),'账单未齐全')
  assert.equal(await page.evaluate(()=>window.__calls.filter(path=>path.startsWith('costs?')).length),heavyBefore,'Opening costs must not automatically reconstruct historical receipts')
  assert.equal(await page.locator('.adm-local-cost-evidence').count(),0)
  await page.locator('.adm-usage-details>summary').click()
  await page.locator('.adm-local-cost-evidence').waitFor()
  assert.equal(await page.evaluate(()=>window.__calls.filter(path=>path.startsWith('costs?')).length),heavyBefore+1)
  assert.match(await page.locator('.adm-local-cost-evidence').textContent(),/536 条费用记录不完整/)
  assert.match(await page.locator('.adm-local-cost-evidence').textContent(),/13 条历史记录尚未归属通道/)
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Costs overflow at '+width)
  await page.screenshot({path:directory+'/costs-partial-'+width+'.png',fullPage:true})
  await page.evaluate(()=>window.__navigate('/admin/overview'))
  await overview('deepseek').locator('.adm-official-amount').getByText('$1.65',{exact:true}).waitFor()
 }
 await page.evaluate(bill=>window.__data.officialBills.push(bill),openai)
 await page.getByRole('button',{name:/刷新数据/}).click()
 await overview('total').locator('.adm-official-amount').getByText('$1.71',{exact:true}).waitFor()
 assert.equal(await overview('total').locator('.adm-official-amount').getAttribute('title'),'1.710000001')
 assert.equal(await overview('openai').locator('.adm-official-amount').innerText(),'$0.05')
 checks.push('Both verified current-account bills produce exact sum 1.710000001 and display 1.71; receipt totals are never substituted')
 await page.evaluate(()=>window.__navigate('/admin/costs'))
 await costs('total').locator('.adm-official-amount').getByText('$1.71',{exact:true}).waitFor()
 await page.locator('.adm-official-breakdown>summary').click()
 const dsBill=page.locator('.adm-bill-provider').filter({hasText:'DeepSeek'})
 assert.equal(await dsBill.locator('b').innerText(),'$1.65');assert.equal(await dsBill.locator('b').getAttribute('title'),'1.658919574')
 assert.match(await page.locator('.adm-official-breakdown').innerText(),/DeepSeek 金额截断为两位小数/)
 await page.evaluate(()=>{window.__data.officialBills[0].currentAccount=false})
 await page.getByRole('button',{name:'查询',exact:true}).click()
 await costs('deepseek').locator('.adm-official-amount').getByText('待同步官方账单',{exact:true}).waitFor()
 assert.equal(await costs('total').locator('.adm-official-amount').innerText(),'账单未齐全')
 checks.push('A stale-account statement is rejected again on refresh without touching historical receipt costs')
 await page.evaluate(()=>{window.__data.officialBills[0].currentAccount=true;window.__data.officialBillReadErrors={deepseek:'unavailable'}})
 const detailReadsBeforeFailure=await page.evaluate(()=>window.__calls.filter(path=>path.startsWith('costs?')).length)
 for(const section of ['overview','costs']){
  await page.setViewportSize({width:1440,height:1100})
  await page.evaluate(section=>window.__navigate('/admin/'+section),section)
  const card=section==='overview'?overview:costs
  await card('deepseek').locator('.adm-official-amount').getByText('账单暂未取得',{exact:true}).waitFor()
  assert.match(await card('deepseek').innerText(),/该通道账单读取暂时失败/)
  assert.doesNotMatch(await card('deepseek').innerText(),/请核对并录入所选账期金额|\$0\.00/)
  assert.equal(await card('openai').locator('.adm-official-amount').innerText(),'$0.05')
  assert.equal(await card('total').locator('.adm-official-amount').innerText(),'账单未齐全')
  assert.match(await page.locator(section==='overview'?'.adm-overview-characters':'.adm-character-total').innerText(),/23,541/)
  await page.evaluate(()=>window.scrollTo(0,0))
  await page.screenshot({path:directory+'/'+section+'-provider-read-failure-1440.png',fullPage:true})
 }
 assert.equal(await page.evaluate(()=>window.__calls.filter(path=>path.startsWith('costs?')).length),detailReadsBeforeFailure,'A provider statement error cannot trigger a heavy fallback query')
 checks.push('A transient DeepSeek statement read failure is isolated in both pages: OpenAI and characters remain usable, no invented zero or manual import prompt, no full-cost fallback query')
 await page.evaluate(()=>{delete window.__data.officialBillReadErrors})
 for(const section of ['overview','costs']){
  await page.evaluate(section=>window.__navigate('/admin/'+section),section)
  const card=section==='overview'?overview:costs
  await card('total').locator('.adm-official-amount').getByText('$1.71',{exact:true}).waitFor()
  assert.equal(await card('total').getByText('合计按原始金额计算，显示取两位小数。',{exact:true}).isVisible(),true,'Precision explanation must be visible beside the total without expanding details')
  assert.equal(await card('total').locator('.adm-official-amount').getAttribute('title'),'1.710000001','Visible explanation must not change the underlying exact sum')
  await page.evaluate(()=>window.scrollTo(0,0))
  await page.screenshot({path:directory+'/'+section+'-complete-1440.png',fullPage:true})
 }
 assert.deepEqual(errors,[]);assert.deepEqual(network,[])
 const result={passed:true,at:new Date().toISOString(),syntheticOnly:true,production:false,externalNetworkRequests:0,pageErrors:errors,checks,viewports:[1440,960,480],savedPeriodRecordsRemainSeparateFromCumulativeFunds:true,automaticReadsUseLightweightSummary:true,fullReceiptsOnlyAfterExplicitExpand:true,exactDeepSeek:'1.658919574',displayedDeepSeek:'$1.65',exactTotal:'1.710000001',directory}
 await writeFile(directory+'/results.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
 await page.evaluate(()=>window.__dispose())
}finally{await browser.close()}
