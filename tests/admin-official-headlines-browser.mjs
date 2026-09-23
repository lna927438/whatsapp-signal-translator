import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {adminOverviewBundle} from './admin-overview-fixture.ts'
import {costsFixture,fundingBalanceFixture,officialBillFixture,nativeMonthFixture} from './admin-costs-fixture.ts'
const {chromium}=createRequire(import.meta.url)('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const directory=fileURLToPath(new URL('../verification/billing-live-20260923/frontend-headlines/',import.meta.url))
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
  window.__data=data;window.__balance=balance;window.__session={id:'fixture-owner',email:'owner@example.invalid',role:'owner'}
  window.__request=async path=>{
   if(path.startsWith('costs?')){
    const result=structuredClone(window.__data)
    if(new URLSearchParams(path.slice(6)).get('officialCurrentMonth')==='true'){
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
 assert.doesNotMatch(await overview('total').innerText(),/历史记录/);assert.match(await page.locator('.adm-receipt-details').textContent(),/13 条历史记录尚未归属通道/)
 assert.equal(await overview('deepseek').locator('strong').innerText(),'待同步官方账单')
 assert.match(await page.locator('.adm-receipt-details').textContent(),/已知费用 · 记录待补齐/)
 checks.push('Official bills exclusively drive primary costs; missing snapshots remain incomplete and 13 historical unassigned records stay in collapsed receipt details')
 await page.screenshot({path:directory+'/overview-missing-bills.png',fullPage:true})
 await page.evaluate(bill=>{window.__data.officialBills=[bill]},deepseek)
 await page.getByRole('button',{name:/刷新数据/}).click()
 await overview('deepseek').locator('.adm-official-amount').getByText('$1.65',{exact:true}).waitFor()
 assert.equal(await overview('deepseek').locator('.adm-official-amount').getAttribute('title'),'1.658919574')
 assert.match(await overview('deepseek').locator('.adm-bill-updated').innerText(),/官方账单手动导入于 .* UTC/)
 assert.equal(await overview('openai').locator('.adm-official-amount').innerText(),'待同步官方账单')
 assert.match(await overview('total').innerText(),/待同步 OpenAI/);assert.doesNotMatch(await overview('total').innerText(),/\$1\.66/)
 checks.push('Imported DeepSeek exact 1.658919574 displays official truncation 1.65; missing OpenAI prevents an official total or differently rounded partial total')
 for(const width of [1440,960,480]){
  await page.setViewportSize({width,height:1100})
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Overview overflow at '+width)
  await page.screenshot({path:directory+'/overview-partial-'+width+'.png',fullPage:true})
  await page.evaluate(()=>window.__navigate('/admin/costs'))
  await costs('deepseek').locator('.adm-official-amount').getByText('$1.65',{exact:true}).waitFor()
  assert.equal(await costs('deepseek').locator('.adm-official-amount').getAttribute('title'),'1.658919574')
  assert.match(await costs('deepseek').locator('.adm-bill-updated').innerText(),/官方账单手动导入于 .* UTC/)
  assert.equal(await costs('total').locator('.adm-official-amount').innerText(),'账单未齐全')
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
 assert.match(await page.locator('.adm-official-breakdown').innerText(),/按官网截断为两位小数/)
 await page.evaluate(()=>{window.__data.officialBills[0].currentAccount=false})
 await page.getByRole('button',{name:'查询',exact:true}).click()
 await costs('deepseek').locator('.adm-official-amount').getByText('待同步官方账单',{exact:true}).waitFor()
 assert.equal(await costs('total').locator('.adm-official-amount').innerText(),'账单未齐全')
 checks.push('A stale-account statement is rejected again on refresh without touching historical receipt costs')
 assert.deepEqual(errors,[]);assert.deepEqual(network,[])
 const result={passed:true,syntheticOnly:true,production:false,externalNetworkRequests:0,pageErrors:errors,checks,viewports:[1440,960,480],officialCostsPrimary:true,exactDeepSeek:'1.658919574',displayedDeepSeek:'$1.65',exactTotal:'1.710000001',directory}
 await writeFile(directory+'/results.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
 await page.evaluate(()=>window.__dispose())
}finally{await browser.close()}
