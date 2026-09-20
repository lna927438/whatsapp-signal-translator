import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {adminOverviewBundle} from './admin-overview-fixture.ts'
import {fundingBalanceFixture,costsFixture} from './admin-costs-fixture.ts'
const require=createRequire(import.meta.url),{chromium}=require('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const bundle=await adminOverviewBundle(),directory=fileURLToPath(new URL('../verification/admin-read-failure-20260920/',import.meta.url))
await mkdir(directory,{recursive:true})
const browser=await chromium.launch({channel:'msedge',headless:true}),checks=[]
try{
  const page=await browser.newPage({viewport:{width:1040,height:1050},locale:'zh-CN'}),errors=[]
  page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>route.abort())
  await page.route('https://admin.fixture.invalid/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><head><style>body{margin:0}</style></head><body><div id="app"></div></body></html>'}))
  await page.goto('https://admin.fixture.invalid/admin/overview')
  await page.evaluate(({balance,data})=>{
    window.__session={id:'fixture-owner',email:'owner@example.invalid',role:'owner'};window.__failed=true
    window.setInterval=()=>1;window.clearInterval=()=>{}
    window.__request=async path=>{
      if(path==='session')return window.__session
      if(path==='provider-balance')return balance
      if(path.startsWith('costs?')){const q=new URLSearchParams(path.split('?')[1]);return {...data,from:q.get('from')+'T00:00:00.000Z',toExclusive:new Date(Date.parse(q.get('to')+'T00:00:00Z')+86400000).toISOString(),timezone:'UTC',snapshotAt:new Date().toISOString()}}
      if(window.__failed)throw Error('管理服务暂不可用。可刷新查询；未确认的操作请继续查询原编号。')
      return {users:14,recentClients:2,todayCharacters:51010,pendingTranslations:0,costs:{mismatches:0},snapshotAt:new Date().toISOString()}
    }
  },{balance:fundingBalanceFixture(Date.now()),data:costsFixture()})
  await page.addScriptTag({content:bundle})
  await page.locator('.adm-overview-users strong').filter({hasText:'尚未取得'}).waitFor()
  await page.locator('.adm-overview-funding .adm-cost-value').waitFor()
  for(const width of [1440,1040,480]){
    await page.setViewportSize({width,height:1050})
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal overflow at '+width)
    assert.equal(await page.locator('.adm-overview-users strong').textContent(),'尚未取得')
    assert.equal(await page.locator('.adm-overview-today strong').textContent(),'尚未取得')
    assert.equal(await page.locator('.adm-status-list div:nth-child(3) dd').textContent(),'尚未取得')
    assert.equal(await page.locator('.adm-status-list div:nth-child(4) dd').textContent(),'尚未取得')
    assert.match(await page.locator('.adm-overview-funding').textContent(),/\$0\.30/)
    await page.screenshot({path:directory+'/unknown-'+width+'.png',fullPage:true})
    checks.push({width,noHorizontalOverflow:true,unknownCounters:true,independentFunds:true})
  }
  await page.evaluate(()=>{window.__failed=false});await page.locator('.adm-heading button').click()
  await page.locator('.adm-overview-users strong').filter({hasText:'14'}).waitFor()
  await page.evaluate(()=>{window.__failed=true});await page.locator('.adm-heading button').click()
  await page.getByText(/保留上次数据，可能已过期/).waitFor()
  assert.equal(await page.locator('.adm-overview-today strong').textContent(),'51,010')
  await page.screenshot({path:directory+'/stale-480.png',fullPage:true})
  await page.evaluate(()=>window.__navigate('/admin/users'))
  await page.getByText('记录尚未取得，请重新加载。',{exact:true}).waitFor()
  assert.doesNotMatch(await page.locator('.adm-list-footer').textContent(),/本页 0 条/)
  assert.deepEqual(errors,[])
  const result={passed:true,at:new Date().toISOString(),fixture:true,production:false,checks,staleLabelKeepsCounts:true,failedListIsUnknown:true,pageErrors:0,directory}
  await writeFile(directory+'/browser-results.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
}finally{await browser.close()}
