import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {adminOverviewBundle} from './admin-overview-fixture.ts'
import {fundingBalanceFixture,costsFixture,officialBillFixture} from './admin-costs-fixture.ts'
const require=createRequire(import.meta.url),{chromium}=require('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const bundle=await adminOverviewBundle(),directory=fileURLToPath(new URL('../verification/provider-funding-ui-20260916/',import.meta.url))
await mkdir(directory,{recursive:true})
const now=Date.now(),data={...costsFixture(),enabledProviders:['deepseek']}
data.officialBills=[officialBillFixture('deepseek','0.19',data)]
const browser=await chromium.launch({channel:'msedge',headless:true}),checks=[]
try{
 const page=await browser.newPage({viewport:{width:1440,height:1100},locale:'zh-CN'}),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>route.abort())
 await page.route('https://admin.fixture.invalid/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><head><style>body{margin:0}</style></head><body><div id="app"></div></body></html>'}))
 await page.goto('https://admin.fixture.invalid/admin/overview')
 await page.evaluate(({data,balance,now})=>{
  window.__data=data;window.__balance=balance;window.__now=now;window.__failed=false;window.__session={id:'fixture-owner',email:'owner@example.invalid',role:'owner'};window.__calls=[]
  const RealDate=Date;window.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[window.__now]))}static now(){return window.__now}}
  const timers=new Map();let id=0;window.setInterval=(fn,ms)=>{timers.set(++id,{fn,ms});return id};window.clearInterval=id=>timers.delete(id);window.__run=ms=>{for(const t of [...timers.values()])if(t.ms===ms)t.fn()}
  window.__request=async path=>{
   window.__calls.push(path)
   if(path==='session')return window.__session
   if(path==='overview')return {users:14,recentClients:2,todayCharacters:100,pendingTranslations:0,snapshotAt:new Date().toISOString(),costs:{mismatches:0}}
   if(path.startsWith('costs?'))return structuredClone(window.__data)
   if(path==='provider-balance'){if(window.__failed)throw Error('余额暂时无法连接，请稍后重试。');return structuredClone(window.__balance)}
   return {enabledProviders:['deepseek'],configured:false,reason:'provider_disabled'}
  }
 },{data,balance:fundingBalanceFixture(now),now})
 await page.addScriptTag({content:bundle});await page.locator('.adm-overview-funding .adm-cost-value').filter({hasText:'$0.30'}).waitFor()
 for(const width of [1440,760,480]){
  await page.setViewportSize({width,height:1100})
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'overview overflow '+width)
  assert.match(await page.locator('.adm-overview-characters').textContent(),/23,541/)
  const card=await page.locator('.adm-overview-funding').textContent();assert.match(card,/累计充值\$20.00/);assert.match(card,/官方余额\$19.70/);assert.doesNotMatch(card,/尚缺|OpenAI|0.19\b/)
  await page.screenshot({path:directory+'/overview-'+width+'.png',fullPage:true})
  await page.evaluate(()=>window.__navigate('/admin/costs'));await page.locator('.adm-provider-funding .adm-cost-value').filter({hasText:'$0.30'}).waitFor()
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'costs overflow '+width)
  assert.match(await page.locator('.adm-official-breakdown').textContent(),/\$0\.19/)
  assert.equal(await page.locator('.adm-local-cost-evidence').evaluate(element=>element.open),false)
  await page.screenshot({path:directory+'/costs-'+width+'.png',fullPage:true})
  checks.push({width,noHorizontalOverflow:true,topups:'20.00',officialBalance:'19.70',used:'0.30',historicalBill:'0.19'})
  await page.evaluate(()=>window.__navigate('/admin/overview'));await page.locator('.adm-overview-funding .adm-cost-value').waitFor()
 }
 await page.setViewportSize({width:480,height:1100})
 await page.evaluate(()=>{window.__failed=true;window.__now+=30000;window.__run(5000)})
 await page.getByText('同步有延迟，当前显示上次核对的资金数据。',{exact:true}).waitFor();assert.match(await page.locator('.adm-overview-funding').textContent(),/\$0\.30/)
 await page.screenshot({path:directory+'/overview-stale-480.png',fullPage:true})
 await page.evaluate(()=>{window.__failed=false;window.__balance.funding.status='needs_confirmation';window.__balance.funding.usedPaid=null;window.__balance.funding.reason='paid_balance_increased';window.__balance.balances[0].paid='39.70';window.__balance.balances[0].total='39.70';window.__now+=30000;window.__run(5000)})
 await page.getByText('待确认累计充值',{exact:true}).waitFor();assert.equal(await page.locator('.adm-overview-funding .adm-cost-value').count(),0)
 await page.screenshot({path:directory+'/overview-needs-confirmation-480.png',fullPage:true})
 await page.evaluate(()=>window.__navigate('/admin/costs'));await page.getByRole('button',{name:'登记充值 / 退款',exact:true}).click();await page.locator('.adm-dialog[open]').waitFor()
 assert.match(await page.locator('.adm-dialog').textContent(),/累计退回付款渠道/);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:directory+'/funding-registration-480.png',fullPage:true})
 await page.getByRole('button',{name:'取消',exact:true}).click();assert.ok(await page.evaluate(()=>!window.__calls.includes('mutate')))
 await page.evaluate(()=>{window.__session={id:'fixture-support',email:'support@example.invalid',role:'support'};window.__calls=[];window.__remount()})
 await page.locator('.adm-provider-funding').waitFor({state:'detached'});assert.ok(await page.evaluate(()=>window.__calls.every(path=>!['provider-balance','billing-status'].includes(path))))
 assert.deepEqual(errors,[])
 const result={passed:true,at:new Date().toISOString(),fixture:true,production:false,liveAccountAccess:false,checks,staleKeepsVerifiedAmount:true,needsConfirmationHidesUsed:true,registrationOnlyExplicit:true,roleRestriction:true,pageErrors:0,directory}
 await writeFile(directory+'/browser-results.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
}finally{await browser.close()}
