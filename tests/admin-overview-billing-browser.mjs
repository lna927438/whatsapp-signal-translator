import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {adminOverviewBundle} from './admin-overview-fixture.ts'
import {balanceFixture,costsFixture,officialBillFixture} from './admin-costs-fixture.ts'
const require=createRequire(import.meta.url),{chromium}=require('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const bundle=await adminOverviewBundle('app'),directory=fileURLToPath(new URL('../verification/billing-overview-alignment-20260915/ui/',import.meta.url));await mkdir(directory,{recursive:true})
const now=Date.now(),data=costsFixture();data.totals.known_cost_usd_exact='0.174394544';data.officialBills=[officialBillFixture('openai','0.0485287',data),officialBillFixture('deepseek','0.19',data)]
data.officialBills.forEach(bill=>{bill.fetched_at=new Date(now-11*60000).toISOString()})
const browser=await chromium.launch({channel:'msedge',headless:true}),checks=[]
try{
 const page=await browser.newPage({viewport:{width:1440,height:1100},locale:'zh-CN'}),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>route.abort())
 await page.setContent('<!doctype html><html lang="zh-CN"><head><style>body{margin:0}</style></head><body><div id="app"></div></body></html>')
 await page.evaluate(({data,balance,now})=>{
  window.__data=data;window.__balance=balance;window.__now=now;window.__failed=true;window.__session={id:'fixture-owner',email:'owner@example.invalid',role:'owner'};window.__calls=[]
  const RealDate=Date;window.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[window.__now]))}static now(){return window.__now}}
  const timers=new Map();let id=0;window.setInterval=(fn,ms)=>{timers.set(++id,{fn,ms});return id};window.clearInterval=id=>timers.delete(id);window.__run=ms=>{for(const t of [...timers.values()])if(t.ms===ms)t.fn()}
  window.__request=async path=>{
   window.__calls.push(path)
   if(path==='session')return window.__session
   if(path==='overview')return {users:14,recentClients:2,todayCharacters:100,pendingTranslations:0,snapshotAt:new Date().toISOString(),costs:{known_cost_usd_exact:'0.174394544',mismatches:0}}
   if(path.startsWith('costs?'))return structuredClone(window.__data)
   if(path==='provider-balance')return window.__balance
   if(path==='billing-sync'&&window.__failed)throw new window.__ApiError('OpenAI 账单账号已停用，请通过官方支持恢复账号。保留上次金额。','billing_account_deactivated')
   return {configured:true,sync:window.__failed?{status:'error',errorCode:'billing_account_deactivated',message:'OpenAI 账单账号已停用，请通过官方支持恢复账号。保留上次金额。'}:{status:'fresh'}}
  }
 },{data,balance:balanceFixture(now),now})
 await page.addScriptTag({content:bundle});await page.locator('.adm-overview-official .adm-cost-value').filter({hasText:'$0.2385287'}).waitFor()
 for(const width of [1440,1024,480]){
  await page.setViewportSize({width,height:1100});await page.waitForTimeout(60)
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No overview horizontal overflow at '+width)
  assert.match(await page.locator('.adm-overview-characters').textContent(),/23,541/)
  assert.match(await page.locator('.adm-overview-official').textContent(),/官方账单同步有延迟/)
  assert.doesNotMatch(await page.locator('.adm-stat-grid').textContent(),/0\.174394544/)
  await page.screenshot({path:directory+'/overview-'+width+'.png',fullPage:true})
  await page.evaluate(()=>window.__navigate('/admin/costs'));await page.locator('.adm-official-cost .adm-cost-value').filter({hasText:'$0.2385287'}).waitFor()
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No costs horizontal overflow at '+width)
  assert.match(await page.locator('.adm-official-cost').textContent(),/OpenAI UTC · DeepSeek GMT\+8/)
  assert.equal(await page.locator('.adm-local-cost-evidence').evaluate(element=>element.open),false)
  assert.match(await page.locator('.adm-official-cost').textContent(),/账单账号已停用/)
  await page.screenshot({path:directory+'/costs-'+width+'.png',fullPage:true})
  if(width===1440){
   await page.locator('select').nth(1).selectOption('deepseek');await page.locator('form').getByRole('button',{name:'查询',exact:true}).click()
   await page.locator('.adm-official-cost .adm-cost-value').filter({hasText:'$0.19'}).waitFor()
   assert.doesNotMatch(await page.locator('.adm-official-cost').textContent(),/账单账号已停用/)
   await page.locator('select').nth(1).selectOption('');await page.locator('form').getByRole('button',{name:'查询',exact:true}).click()
   await page.locator('.adm-official-cost .adm-cost-value').filter({hasText:'$0.2385287'}).waitFor()
  }
  checks.push({width,noHorizontalOverflow:true,exactOfficialTotal:'0.2385287',nativePeriodsLabeled:true,oldReceiptCostNotHeadline:true,accountFailureVisibleInHeadlineCard:true})
  await page.evaluate(()=>window.__navigate('/admin/overview'));await page.locator('.adm-overview-official .adm-cost-value').waitFor()
 }
 await page.setViewportSize({width:1440,height:1100})
 await page.evaluate(()=>{window.__data.officialBills.pop();window.__run(5000)})
 await page.locator('.adm-overview-pending').waitFor();assert.match(await page.locator('.adm-overview-partial').textContent(),/已同步部分：\$0\.0485287/)
 assert.equal(await page.locator('.adm-overview-official .adm-cost-value').count(),0)
 await page.screenshot({path:directory+'/overview-missing-statement.png',fullPage:true})
 await page.evaluate(data=>{window.__data=data;window.__run(5000)},data);await page.locator('.adm-overview-official .adm-cost-value').waitFor()
 await page.evaluate(()=>window.__navigate('/admin/costs'));await page.getByRole('button',{name:'同步官方账单',exact:true}).click()
 await page.waitForFunction(()=>document.body.textContent.includes('账单账号已停用'))
 await page.evaluate(()=>{window.__failed=false;window.__now+=2000;window.__data.snapshotAt=new Date().toISOString();window.__data.officialBills[0].fetched_at=new Date().toISOString();window.__run(10000)})
 await page.getByText('OpenAI 官方账单已恢复同步。',{exact:true}).waitFor()
 assert.doesNotMatch(await page.locator('body').textContent(),/账单账号已停用/)
 assert.match(await page.locator('.adm-official-cost').textContent(),/\$0\.2385287/)
 await page.screenshot({path:directory+'/costs-synthetic-recovery.png',fullPage:true})
 await page.evaluate(()=>{window.__session={id:'fixture-support',email:'support@example.invalid',role:'support'};window.__calls=[];window.__remount()})
 await page.locator('.adm-official-cost').waitFor({state:'detached'});await page.waitForTimeout(80)
 assert.equal(await page.locator('.adm-provider-balance').count(),0)
 assert.ok(await page.evaluate(()=>window.__calls.every(path=>!['provider-balance','billing-status','billing-sync'].includes(path))))
 assert.deepEqual(errors,[])
 const result={passed:true,at:new Date().toISOString(),fixture:true,liveAccountAccess:false,productionRecoveryClaimed:false,checks,deepseekOnlyExcludesOpenAIAccountWarning:true,missingBillNotZero:true,syntheticReadAndSyncRecovery:true,roleRestriction:true,pageErrors:0,directory}
 await writeFile(directory+'/browser-results.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
}finally{await browser.close()}
