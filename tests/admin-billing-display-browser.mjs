import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {adminOverviewBundle} from './admin-overview-fixture.ts'
import {fundingBalanceFixture,costsFixture} from './admin-costs-fixture.ts'
const {chromium}=createRequire(import.meta.url)('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const directory=fileURLToPath(new URL('../verification/admin-timeout-20260924/browser-missing/',import.meta.url))
await mkdir(directory,{recursive:true})
const bundle=await adminOverviewBundle(),data=costsFixture()
Object.assign(data,{enabledProviders:['deepseek'],translationProviders:['deepseek'],defaultTranslationProvider:'deepseek',translationModels:{deepseek:{model:'deepseek-v4-pro',displayName:'deepseek-v4-pro'},openai:{model:'gpt-5.6-luna',displayName:'gpt-5.6-luna'}}})
Object.assign(data.totals,{charged_characters:1120397,known_cost_usd_exact:'1.602070596',unpriced_requests:536})
data.providers=[{provider:'deepseek',known_cost_usd_exact:'1.189730596',unpriced_requests:535},{provider:'openai',known_cost_usd_exact:'0.41234',unpriced_requests:1}]
const browser=await chromium.launch({channel:'msedge',headless:true}),errors=[],network=[],checks=[]
try{
 const page=await browser.newPage({viewport:{width:1440,height:1100},locale:'zh-CN'})
 page.on('pageerror',e=>errors.push(e.message))
 await page.route('**/*',route=>{network.push(route.request().url());return route.abort()})
 await page.setContent('<!doctype html><html lang="zh-CN"><head><style>body{margin:0}</style></head><body><div id="app"></div></body></html>')
 await page.evaluate(({data,balance})=>{
  window.__session={id:'fixture-owner',email:'owner@example.invalid',role:'owner'};window.__calls=[];window.__failed=false;window.__data=data
  window.__request=async path=>{
   window.__calls.push(path)
   if(path==='session')return window.__session
   if(path==='overview')return {users:27,recentClients:16,todayCharacters:362375,pendingTranslations:0,snapshotAt:new Date().toISOString(),costs:{mismatches:0}}
   if(path.startsWith('billing-summary?')){
    if(window.__failed)throw Error('合成断网检查')
    const result=structuredClone(window.__data)
    result.totals={charged_characters:result.totals.charged_characters,refunded_characters:result.totals.refunded_characters}
    for(const key of ['providers','users','days','providerBalance'])delete result[key]
    return result
   }
   if(path==='provider-balance')return structuredClone(balance)
   throw Error('Unexpected fixture route')
  }
 },{data,balance:fundingBalanceFixture()})
 await page.addScriptTag({content:bundle})
 await page.locator('.adm-overview-cost .adm-official-amount').filter({hasText:'账单未齐全'}).waitFor()
 for(const width of [1440,1040,480]){
  await page.setViewportSize({width,height:1100})
  const grid=page.locator('.adm-overview-cost-grid')
  assert.equal(await grid.locator('article').count(),3)
  assert.equal(await grid.locator('[data-provider="deepseek"] .adm-official-amount').innerText(),'待同步官方账单')
  assert.equal(await grid.locator('[data-provider="openai"] .adm-official-amount').innerText(),'待同步官方账单')
  assert.equal(await grid.locator('.adm-overview-cost .adm-official-amount').innerText(),'账单未齐全')
  assert.doesNotMatch(await grid.innerText(),/536 条费用记录不完整/);assert.match(await page.locator('.adm-receipt-details').textContent(),/历史回执核算按需读取，未加载的明细不会显示为零/)
  assert.equal(await grid.locator('[data-provider="deepseek"] strong').innerText(),'待同步官方账单')
  assert.equal(await grid.locator('[data-provider="openai"] strong').innerText(),'待同步官方账单')
  assert.equal(await grid.locator('.adm-overview-cost strong').innerText(),'账单未齐全')
  assert.doesNotMatch(await page.locator('.adm-receipt-details').textContent(),/已知费用.*\$0|536 条费用记录不完整/)
  assert.match(await grid.locator('[data-provider="openai"]').innerText(),/未开放选择/)
  assert.equal(await page.locator('.adm-overview-billing-details').evaluate(el=>el.open),false)
  assert.equal(await page.locator('.adm-overview-funding').isVisible(),true)
  assert.equal(await page.locator('.adm-overview-funding').locator('xpath=ancestor::details[not(@open)]').count(),0)
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal overflow at '+width)
  if(width>700){const boxes=await grid.locator('article').evaluateAll(cards=>cards.map(card=>card.getBoundingClientRect().top));assert.ok(Math.max(...boxes)-Math.min(...boxes)<1,'Comparable cards on the same row')}
  await page.screenshot({path:directory+`overview-${width}.png`,fullPage:true})
  checks.push({width,threeCards:true,noHorizontalOverflow:true})
 }
 await page.locator('.adm-overview-funding').waitFor({state:'visible'})
 assert.match(await page.locator('.adm-overview-funding').innerText(),/\$0\.30/)
 await page.evaluate(()=>window.__failed=true)
 await page.getByRole('button',{name:/刷新数据/}).click()
 await page.getByText('读取失败，保留上次费用；当前显示可能过期。',{exact:true}).waitFor()
 assert.equal(await page.locator('.adm-overview-cost .adm-official-amount').innerText(),'账单未齐全')
 assert.equal(await page.locator('.adm-overview-cost strong').innerText(),'账单未齐全')
 assert.equal(await page.evaluate(()=>window.__data.totals.known_cost_usd_exact),'1.602070596')
 assert.equal(await page.evaluate(()=>window.__calls.some(path=>path.startsWith('costs?'))),false)
 assert.deepEqual(errors,[]);assert.deepEqual(network,[])
 const report={passed:true,at:new Date().toISOString(),syntheticOnly:true,production:false,checks,pageErrors:errors,externalRequests:network.length,unloadedReceiptsNotPresentedAsZero:true,automaticReadsUseLightweightSummary:true,staleAmountsLabeled:true,automaticFundsVisibleWithoutExpanding:true,missingOfficialBillsNeverSubstituteReceipts:true}
 await writeFile(directory+'results.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))
 await page.evaluate(()=>window.__dispose())
}finally{await browser.close()}
