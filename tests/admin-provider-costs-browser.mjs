import assert from 'node:assert/strict'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {adminCostsBundle,fundingBalanceFixture,costsFixture,officialBillFixture,nativeMonthFixture} from './admin-costs-fixture.ts'
const {chromium}=createRequire(import.meta.url)('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const directory=fileURLToPath(new URL('../verification/billing-live-20260923/frontend-provider-costs/',import.meta.url))
await mkdir(directory,{recursive:true})
const bundle=await adminCostsBundle(),css=await readFile(new URL('../website/src/admin/admin.css',import.meta.url),'utf8')
const data={...costsFixture(),enabledProviders:['openai','deepseek'],translationProviders:['deepseek','openai'],defaultTranslationProvider:'deepseek',translationModels:{openai:{model:'gpt-5.6-luna',displayName:'gpt-5.6-luna'},deepseek:{model:'deepseek-v4-pro',displayName:'deepseek-v4-pro'}}}
Object.assign(data.totals,{known_cost_usd_exact:'0.0579',provider_requests:10,total_tokens:300,unpriced_requests:1})
data.providers=[{provider:'openai',requests:3,total_tokens:96,known_cost_usd_exact:'0.0123',unpriced_requests:0},{provider:'deepseek',requests:7,total_tokens:204,known_cost_usd_exact:'0.0456',unpriced_requests:1}]
data.officialBills=[officialBillFixture('openai','0.015',data),officialBillFixture('deepseek','0.05',data)]
const browser=await chromium.launch({channel:'msedge',headless:true}),errors=[],network=[]
try{
 const page=await browser.newPage({viewport:{width:1440,height:1250},locale:'zh-CN'})
 page.on('pageerror',error=>errors.push(error.message))
 await page.route('**/*',route=>{network.push(route.request().url());return route.abort()})
 await page.setContent('<!doctype html><html lang="zh-CN"><head><style>body{margin:0}'+css+'</style></head><body class="admin-root"><aside class="adm-sidebar"><div class="adm-brand">HelloDog</div><nav><a class="selected">用量与费用</a></nav></aside><main class="adm-main"><div class="adm-content"><div class="adm-heading"><div><h1>用量与费用</h1><p>本地隔离验收 · 全部金额与用量均为合成样例</p></div></div><div id="app"></div></div></main></body></html>')
 await page.evaluate(({data,balance,nativeBasis})=>{
  window.__calls=[];window.__data=data;window.__fail=false
  window.__request=async path=>{
   window.__calls.push(path)
   if(path.startsWith('costs?')){
    if(window.__fail)throw Error('合成读取失败')
    const result=structuredClone(window.__data),selected=new URLSearchParams(path.slice(6)).get('provider')
    if(selected){
     result.providers=result.providers?.filter(row=>row.provider===selected)
     const row=result.providers?.[0]
     Object.assign(result.totals,{known_cost_usd_exact:row?.known_cost_usd_exact??'0',provider_requests:row?.requests??0,total_tokens:row?.total_tokens??0,unpriced_requests:row?.unpriced_requests??0,charged_characters:selected==='deepseek'?17000:6541})
    }
    if(new URLSearchParams(path.slice(6)).get('officialCurrentMonth')==='true'){result.officialBillingBasis=nativeBasis;for(const bill of result.officialBills){const period=nativeBasis.periods[bill.provider],offset=bill.provider==='deepseek'?28800000:0;bill.period_from=new Date(Date.parse(period.from+'T00:00:00Z')-offset).toISOString();bill.period_to=new Date(Date.parse(period.to+'T00:00:00Z')+86400000-offset).toISOString()}}
    return result
   }
   if(path==='provider-balance')return structuredClone(balance)
   if(path==='billing-status')return {enabledProviders:window.__data.enabledProviders,configured:false,reason:'local_fixture'}
   throw Error('Unexpected fixture request: '+path)
  }
 },{data,balance:fundingBalanceFixture(),nativeBasis:nativeMonthFixture(structuredClone(data),Date.parse(data.snapshotAt)).officialBillingBasis})
 await page.addScriptTag({content:bundle})
 const card=name=>page.locator('.adm-provider-cost-card[data-provider="'+name+'"]'),amount=name=>card(name).locator('.adm-provider-amount')
 await amount('openai').getByText('$0.02',{exact:true}).waitFor()
 assert.deepEqual(await page.locator('.adm-provider-cost-card h2').allTextContents(),['DeepSeek','OpenAI','合计'])
 const openai=await card('openai').innerText(),deepseek=await card('deepseek').innerText(),total=await card('total').innerText()
 assert.match(openai,/\$0\.02/);assert.doesNotMatch(openai,/3 次调用|96 Tokens/);assert.match(await page.locator('.adm-local-cost-evidence').textContent(),/3 次调用.*96 Tokens/)
 assert.match(openai,/gpt-5\.6-luna/);assert.match(openai,/已开放选择/);assert.match(deepseek,/deepseek-v4-pro/);assert.match(deepseek,/已开放选择 · 默认/)
 assert.match(deepseek,/\$0\.05/);assert.doesNotMatch(deepseek,/7 次调用|费用记录不完整/);assert.match(await page.locator('.adm-local-cost-evidence').textContent(),/7 次调用.*204 Tokens/)
 assert.match(total,/全部通道/);assert.equal(await amount('total').innerText(),'$0.07');assert.doesNotMatch(total,/10 次调用|费用记录不完整/);assert.match(await page.locator('.adm-local-cost-evidence').textContent(),/10 次调用 · 300 Tokens/);assert.match(total,/23,541/)
 assert.equal(await page.locator('.adm-official-breakdown').evaluate(element=>element.open),false)
 assert.equal(await page.locator('.adm-local-cost-evidence').evaluate(element=>element.open),false)
 assert.equal(await page.locator('.adm-provider-cost-grid .adm-provider-funding').count(),0,'Account funding must not be summed as API cost')
 assert.match(await page.locator('.adm-account-funding').textContent(),/\$0\.30/);assert.equal(await page.locator('.adm-account-funding').evaluate(el=>el.open),false)
 for(const width of [1440,960,480]){
  await page.setViewportSize({width,height:1100});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No overflow at '+width)
  assert.equal(await page.locator('.adm-provider-cost-card').count(),3)
  await page.screenshot({path:directory+'/provider-costs-'+width+'.png',fullPage:true})
 }
 await page.locator('.adm-official-breakdown>summary').click()
 assert.equal(await page.locator('.adm-official-total b').innerText(),'$0.07')
 assert.match(await page.locator('.adm-bill-provider').filter({hasText:'OpenAI'}).innerText(),/\$0\.02/)
 assert.match(await page.locator('.adm-bill-provider').filter({hasText:'DeepSeek'}).innerText(),/\$0\.05/)
 const select=page.locator('form select').nth(1),query=page.getByRole('button',{name:'查询',exact:true})
 await select.selectOption('deepseek');assert.equal(await amount('total').innerText(),'$0.07','Unsubmitted filters do not relabel old data')
 await query.click();await amount('openai').getByText('未纳入筛选',{exact:true}).waitFor()
 assert.equal(await amount('deepseek').innerText(),'$0.05');assert.equal(await amount('total').innerText(),'请选全部通道查看合计');assert.doesNotMatch(await card('total').innerText(),/待同步 OpenAI|账单未齐全|已同步部分/)
 assert.match(await page.locator('.adm-query-period').innerText(),/DeepSeek/)
 assert.doesNotMatch(await card('openai').innerText(),/\$0\.00|3 次调用/)
 await page.evaluate(()=>{window.__fail=true});await select.selectOption('openai');await query.click();await page.getByText(/合成读取失败/).waitFor()
 assert.match(await page.locator('.adm-query-period').innerText(),/DeepSeek/);assert.equal(await amount('total').innerText(),'请选全部通道查看合计','Failed query preserves its original scope')
 assert.match(await card('openai').innerText(),/状态待重新确认/)
 await page.evaluate(()=>{window.__fail=false;window.__data.translationProviders=['deepseek'];window.__data.enabledProviders=['deepseek']})
 await query.click();await card('openai').locator('.adm-official-amount').getByText('待同步官方账单',{exact:true}).waitFor();assert.equal(await amount('openai').innerText(),'待同步官方账单')
 assert.match(await card('openai').innerText(),/未开放选择/);assert.equal(await page.locator('.adm-retired-provider').count(),1,'Retired provider history remains visible')
 await select.selectOption('');await page.evaluate(()=>{delete window.__data.providers});await query.click();await amount('deepseek').getByText('$0.05',{exact:true}).waitFor()
 assert.match(await page.locator('.adm-local-cost-evidence').textContent(),/尚未取得/,'Missing provider receipt breakdown cannot be displayed as zero');assert.equal(await card('deepseek').locator('.adm-official-amount').innerText(),'$0.05')
 await page.evaluate(()=>{window.__data.providers=[];window.__data.totals={known_cost_usd_exact:'0',provider_requests:0,total_tokens:0,charged_characters:0,unpriced_requests:0}})
 await query.click();await amount('total').getByText('账单未齐全',{exact:true}).waitFor()
 assert.equal(await amount('deepseek').innerText(),'$0.05');assert.equal(await amount('openai').innerText(),'待同步官方账单','Empty receipts cannot fabricate an official zero');assert.match(await page.locator('.adm-local-cost-evidence').textContent(),/\$0\.00/);assert.equal(await card('deepseek').locator('.adm-official-amount').innerText(),'$0.05','Receipts cannot overwrite the official bill')
 await page.evaluate(()=>window.__setAccess(false));await page.locator('.adm-account-funding').waitFor({state:'detached'})
 assert.equal(await page.locator('.adm-official-breakdown').count(),0);assert.equal(await page.locator('.adm-provider-cost-card').count(),3,'API receipt costs remain available to authorized non-owner roles')
 assert.deepEqual(errors,[]);assert.deepEqual(network,[])
 const result={passed:true,syntheticOnly:true,production:false,realAccountAccess:false,realNetworkRequests:network.length,renderedComponent:'AdminCosts.vue and its actual child components',calls:await page.evaluate(()=>window.__calls),knownCosts:{openai:'0.0123',deepseek:'0.0456',total:'0.0579',unpriced:1},displayedOfficialCosts:{openai:'$0.02',deepseek:'$0.05',total:'$0.07'},officialCostsPrimary:true,providerRequests:10,tokens:300,customerCharacters:23541,officialBills:{openai:'0.015',deepseek:'0.05',total:'0.065'},filteredScope:true,failedReadPreservesScope:true,retiredHistoryPreserved:true,missingVsZeroDistinct:true,ownerOnlyFunding:true,viewports:[1440,960,480],pageErrors:errors,screenshot:'provider-costs-1440.png'}
 await writeFile(directory+'/results.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
 await page.evaluate(()=>window.__dispose())
}finally{await browser.close()}
