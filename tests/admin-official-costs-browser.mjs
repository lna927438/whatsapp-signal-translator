import assert from 'node:assert/strict'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {adminCostsBundle,balanceFixture,costsFixture,officialBillFixture} from './admin-costs-fixture.ts'
const require=createRequire(import.meta.url),{chromium}=require('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const bundle=await adminCostsBundle(),css=await readFile(new URL('../website/src/admin/admin.css',import.meta.url),'utf8')
const directory=fileURLToPath(new URL('../verification/billing-official-primary-20260915/ui/',import.meta.url));await mkdir(directory,{recursive:true})
const browser=await chromium.launch({channel:'msedge',headless:true}),checks=[]
try{
  const page=await browser.newPage({viewport:{width:1440,height:1100},locale:'zh-CN'}),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>route.abort())
  await page.setContent('<!doctype html><html lang="zh-CN"><head><style>body{margin:0}'+css+'</style></head><body class="admin-root"><aside class="adm-sidebar"><div class="adm-brand">HelloDog</div><nav><a class="selected">用量与费用</a></nav></aside><main class="adm-main"><div class="adm-content"><div class="adm-heading"><div><h1>用量与费用</h1><p>本地样例 · 官方账单主卡验收</p></div></div><div id="app"></div></div></main></body></html>')
  const costs=costsFixture();costs.officialBills=[officialBillFixture('openai','0.032911700001',costs)]
  const full=structuredClone(costs);full.officialBills.push(officialBillFixture('deepseek','0.190000000009',costs))
  await page.evaluate(({costs,full,balance})=>{window.__costs=costs;window.__full=full;window.__balance=balance;window.__request=async path=>path.startsWith('costs?')?window.__costs:path==='provider-balance'?window.__balance:path==='billing-sync'?(window.__costs=window.__full,{message:'样例官方账单已同步'}):{configured:true}},{costs,full,balance:balanceFixture()})
  await page.addScriptTag({content:bundle});await page.locator('.adm-official-pending').waitFor()
  for(const width of [1440,1024,480]){
    await page.setViewportSize({width,height:1100});await page.waitForTimeout(80)
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal overflow at '+width)
    assert.equal(await page.locator('.adm-official-cost').count(),1);assert.match(await page.locator('.adm-official-cost').textContent(),/尚缺官方账单/)
    assert.match(await page.locator('.adm-official-partial').textContent(),/\$0\.032911700001/);assert.equal(await page.locator('.adm-local-cost-evidence').evaluate(element=>element.open),false)
    checks.push({width,noHorizontalOverflow:true,partialClearlyLabeled:true,localEstimateCollapsed:true});await page.screenshot({path:directory+'/official-partial-'+width+'.png',fullPage:true})
  }
  await page.setViewportSize({width:1440,height:1100});await page.getByRole('button',{name:'同步官方账单',exact:true}).click()
  await page.locator('.adm-official-cost .adm-cost-value').filter({hasText:'$0.22291170001'}).waitFor()
  assert.match(await page.locator('.adm-official-cost').textContent(),/OpenAI UTC · DeepSeek GMT\+8/);assert.match(await page.locator('.adm-official-breakdown').textContent(),/官方账单 · 手动录入/)
  const cardBeforeBalance=await page.locator('.adm-official-cost').textContent()
  await page.evaluate(()=>{window.__balance.fetchedAt=new Date(Date.now()+1000).toISOString();window.__balance.balances[0].total='11.000000000001'})
  await page.getByRole('button',{name:'刷新余额',exact:true}).click();await page.getByText('USD 11.000000000001',{exact:true}).waitFor()
  assert.equal(await page.locator('.adm-official-cost').textContent(),cardBeforeBalance,'Balance polling cannot advance the official bill amount or sample time')
  await page.screenshot({path:directory+'/official-complete-1440.png',fullPage:true})
  await page.evaluate(()=>window.__setAccess(false));await page.locator('.adm-official-cost').waitFor({state:'detached'});assert.equal(await page.locator('.adm-provider-balance').count(),0)
  assert.deepEqual(errors,[])
  const result={passed:true,at:new Date().toISOString(),fixture:true,liveAccountAccess:false,checks,officialSyncReplacesPrimaryCard:true,exactNativePeriodTotal:'0.22291170001',balanceRefreshDoesNotRelabelBills:true,ownerOnly:true,pageErrors:0}
  await writeFile(directory+'/browser-results.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({...result,directory}))
}finally{await browser.close()}
