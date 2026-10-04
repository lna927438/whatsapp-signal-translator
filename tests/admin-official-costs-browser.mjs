import assert from 'node:assert/strict'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {adminCostsBundle,balanceFixture,costsFixture,officialBillFixture,nativeMonthFixture} from './admin-costs-fixture.ts'
const require=createRequire(import.meta.url),{chromium}=require('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const bundle=await adminCostsBundle(),css=await readFile(new URL('../website/src/admin/admin.css',import.meta.url),'utf8')
const directory=fileURLToPath(new URL('../verification/billing-live-20260923/frontend-browser/',import.meta.url));await mkdir(directory,{recursive:true})
const browser=await chromium.launch({channel:'msedge',headless:true}),checks=[]
try{
  const page=await browser.newPage({viewport:{width:1440,height:1100},locale:'zh-CN'}),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>route.abort())
  await page.setContent('<!doctype html><html lang="zh-CN"><head><style>body{margin:0}'+css+'</style></head><body class="admin-root"><aside class="adm-sidebar"><div class="adm-brand">HelloDog</div><nav><a class="selected">用量与费用</a></nav></aside><main class="adm-main"><div class="adm-content"><div class="adm-heading"><div><h1>用量与费用</h1><p>本地合成样例 · 官方账单与 API 费用分开核对</p></div></div><div id="app"></div></div></main></body></html>')
  const costs=costsFixture();costs.officialBills=[officialBillFixture('openai','0.032911700001',costs)]
  costs.providers=[{provider:'deepseek',known_cost_usd_exact:'1.830000000001',unpriced_requests:0,requests:240,total_tokens:90000},{provider:'openai',known_cost_usd_exact:'0.032911700001',unpriced_requests:0,requests:5,total_tokens:2500}]
  costs.totals.known_cost_usd_exact='1.862911700002'
  const full=structuredClone(costs);full.officialBills.push(officialBillFixture('deepseek','1.658919574',costs));full.officialBills[1].fetched_at=new Date(Date.now()-3600000).toISOString()
  await page.evaluate(({costs,full,balance,nativeBasis})=>{window.__costs=costs;window.__full=full;window.__balance=balance;window.__request=async path=>path.startsWith('costs?')?(()=>{const result=structuredClone(window.__costs);if(new URLSearchParams(path.slice(6)).get('officialCurrentMonth')==='true'){result.officialBillingBasis=nativeBasis;for(const bill of result.officialBills){const period=nativeBasis.periods[bill.provider],offset=bill.provider==='deepseek'?28800000:0;bill.period_from=new Date(Date.parse(period.from+'T00:00:00Z')-offset).toISOString();bill.period_to=new Date(Date.parse(period.to+'T00:00:00Z')+86400000-offset).toISOString()}}return result})():path==='provider-balance'?window.__balance:path==='billing-sync'?(window.__costs=window.__full,{message:'样例官方账单已同步'}):{configured:true}},{costs,full,balance:balanceFixture(),nativeBasis:nativeMonthFixture(structuredClone(costs),Date.parse(costs.snapshotAt)).officialBillingBasis})
  await page.addScriptTag({content:bundle});await page.locator('.adm-official-breakdown>summary').filter({hasText:'尚未齐全'}).waitFor()
  assert.equal(await page.locator('.adm-official-breakdown').evaluate(element=>element.open),false)
  await page.locator('.adm-official-breakdown>summary').click()
  for(const width of [1440,1024,480]){
    await page.setViewportSize({width,height:1100});await page.waitForTimeout(80)
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal overflow at '+width)
    assert.equal(await page.locator('.adm-official-breakdown').count(),1);assert.match(await page.locator('.adm-official-total').textContent(),/尚未齐全/)
    assert.match(await page.locator('.adm-official-total').textContent(),/待同步 DeepSeek/);assert.doesNotMatch(await page.locator('.adm-official-total').textContent(),/\$0\.03/);assert.equal(await page.locator('.adm-local-cost-evidence').evaluate(element=>element.open),false)
    assert.equal(await page.locator('.adm-provider-cost-card').count(),3)
    assert.equal(await page.locator('[data-provider="deepseek"] .adm-provider-amount').textContent(),'待同步官方账单')
    assert.equal(await page.locator('[data-provider="total"] .adm-provider-amount').textContent(),'账单未齐全')
    assert.match(await page.locator('.adm-cost-freshness').textContent(),/约每 30 秒重读已保存记录.*手工金额不会自动更新.*页面读取于/)
    checks.push({width,noHorizontalOverflow:true,partialClearlyLabeled:true,localEstimateCollapsed:true});await page.screenshot({path:directory+'/official-partial-'+width+'.png',fullPage:true})
  }
  await page.setViewportSize({width:1440,height:1100});await page.getByRole('button',{name:'同步官方账单',exact:true}).click()
  await page.locator('.adm-official-total b').filter({hasText:'$1.69'}).waitFor()
  assert.equal(await page.locator('[data-provider="deepseek"] .adm-provider-amount').textContent(),'$1.65')
  assert.equal(await page.locator('[data-provider="deepseek"] .adm-official-amount').textContent(),'$1.65')
  assert.match(await page.locator('[data-provider="deepseek"] .adm-bill-notice').textContent(),/此金额为手工录入.*不会自动补入新费用.*重新核对/)
  assert.match(await page.locator('.adm-official-breakdown').textContent(),/OpenAI UTC · DeepSeek GMT\+8/);assert.match(await page.locator('.adm-official-breakdown').textContent(),/手工录入 · 录入于/)
  assert.doesNotMatch(await page.locator('.adm-official-breakdown').textContent(),/官方导出|官方账单 · 手动录入/)
  const cardBeforeBalance=await page.locator('.adm-official-breakdown').textContent(),apiCostsBeforeBalance=await page.locator('.adm-provider-cost-grid').textContent()
  await page.evaluate(()=>{window.__balance.fetchedAt=new Date(Date.now()+1000).toISOString();window.__balance.balances[0].total='11.000000000001'})
  assert.equal(await page.locator('.adm-account-funding').isVisible(),true);await page.getByRole('button',{name:'刷新资金',exact:true}).click();await page.locator('.adm-funding-balance strong').filter({hasText:'$11.00'}).waitFor()
  assert.equal(await page.locator('.adm-official-breakdown').textContent(),cardBeforeBalance,'Balance polling cannot advance the official bill amount or sample time')
  assert.equal(await page.locator('.adm-provider-cost-grid').textContent(),apiCostsBeforeBalance,'Balance changes cannot alter official headline costs')
  await page.screenshot({path:directory+'/official-complete-1440.png',fullPage:true})
  await page.evaluate(()=>window.__setAccess(false));await page.locator('.adm-official-breakdown').waitFor({state:'detached'});assert.equal(await page.locator('.adm-provider-funding').count(),0)
  assert.deepEqual(errors,[])
  const result={passed:true,at:new Date().toISOString(),fixture:true,liveAccountAccess:false,checks,officialSyncUpdatesBreakdown:true,savedPeriodRecordsRemainSeparateFromCumulativeFunds:true,collapsedReceiptTotal:'$1.86',exactNativePeriodTotal:'1.691831274001',displayedNativePeriodTotal:'$1.69',balanceRefreshDoesNotRelabelBillsOrApiCosts:true,ownerOnly:true,pageErrors:0}
  await writeFile(directory+'/browser-results.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({...result,directory}))
}finally{await browser.close()}
