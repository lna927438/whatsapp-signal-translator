import assert from 'node:assert/strict'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {adminCostsBundle,balanceFixture,costsFixture} from './admin-costs-fixture.ts'
const require=createRequire(import.meta.url),{chromium}=require('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const bundle=await adminCostsBundle(),css=await readFile(new URL('../website/src/admin/admin.css',import.meta.url),'utf8')
const directory=fileURLToPath(new URL('../verification/maintenance-2026-09-15/balance-ui/',import.meta.url));await mkdir(directory,{recursive:true})
const browser=await chromium.launch({channel:'msedge',headless:true}),checks=[]
try {
 const page=await browser.newPage({viewport:{width:1440,height:1100},locale:'zh-CN'}),errors=[];page.on('pageerror',error=>errors.push(error.message))
 await page.route('**/*',route=>route.abort())
 await page.setContent('<!doctype html><html lang="zh-CN"><head><style>body{margin:0}'+css+'</style></head><body class="admin-root"><aside class="adm-sidebar"><div class="adm-brand">HelloDog</div><nav><a class="selected">用量与费用</a></nav></aside><main class="adm-main"><div class="adm-content"><div class="adm-heading"><div><h1>用量与费用</h1><p>本地样例 · 页面验收</p></div></div><div id="app"></div></div></main></body></html>')
 await page.evaluate(({costs,balance})=>{window.__calls=[];window.__balance=balance;window.__balanceFail=false;window.__request=async path=>{window.__calls.push(path);if(path.startsWith('costs?'))return costs;if(path==='provider-balance'){if(window.__balanceFail)throw Error('连接暂时中断');return window.__balance}return {configured:true,message:'已完成官方同步'}}},{costs:costsFixture(),balance:balanceFixture()})
 await page.addScriptTag({content:bundle});await page.getByText('USD 1,234.123456789012',{exact:true}).waitFor()
 for(const width of [1440,1024,480]){
  await page.setViewportSize({width,height:1100});await page.waitForTimeout(80)
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal overflow at '+width)
  assert.equal(await page.locator('.adm-provider-balance').count(),1);assert.equal(await page.locator('.adm-balance-total').count(),2)
  checks.push({width,noHorizontalOverflow:true,separateUsdCny:true,oneBalanceCard:true})
  await page.screenshot({path:directory+'/balance-'+width+'.png',fullPage:true})
 }
 await page.setViewportSize({width:1440,height:1100})
 await page.evaluate(()=>{window.__balance.balances[0].total='12.987654321098';window.__balance.fetchedAt=new Date().toISOString()})
 await page.getByRole('button',{name:'刷新余额',exact:true}).click();await page.getByText('USD 12.987654321098',{exact:true}).waitFor()
 await page.evaluate(()=>window.__balanceFail=true);await page.getByRole('button',{name:'刷新余额',exact:true}).click();await page.getByText('同步未完成，保留上次余额',{exact:true}).waitFor();assert.equal(await page.locator('.adm-balance-total').first().textContent(),'USD 12.987654321098')
 await page.screenshot({path:directory+'/balance-retry.png',fullPage:true});assert.deepEqual(errors,[])
 await writeFile(directory+'/browser-results.json',JSON.stringify({passed:true,at:new Date().toISOString(),fixture:true,liveAccountAccess:false,checks,manualRefreshUpdatesMainCard:true,errorRetainsExactPriorAmount:true,pageErrors:errors},null,2)+'\n')
 console.log(JSON.stringify({passed:true,checks,manualRefreshUpdatesMainCard:true,errorRetainsExactPriorAmount:true,pageErrors:0,directory}))
}finally{await browser.close()}
