import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {adminOverviewBundle} from './admin-overview-fixture.ts'
import {fundingBalanceFixture,costsFixture} from './admin-costs-fixture.ts'

const {chromium}=createRequire(import.meta.url)('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const websiteRequire=createRequire(new URL('../website/package.json',import.meta.url)),{build}=createRequire(websiteRequire.resolve('wrangler'))('esbuild')
const gateway=await build({entryPoints:[fileURLToPath(new URL('../server/worker/src/admin.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'node',target:'node24'})
const {validateMutation}=await import('data:text/javascript;base64,'+Buffer.from(gateway.outputFiles[0].text).toString('base64'))
const directory=fileURLToPath(new URL('../verification/admin-statement-optional-fields-20260924/',import.meta.url))
await mkdir(directory,{recursive:true})
const bundle=await adminOverviewBundle(),data={...costsFixture(),enabledProviders:['deepseek']}
const user={id:'30000000-0000-4000-8000-000000000001',email:'sample@example.invalid',status:'active',balance:1000}
const browser=await chromium.launch({channel:'msedge',headless:true}),checks=[],errors=[],network=[]
try{
 const page=await browser.newPage({viewport:{width:1365,height:1100},locale:'zh-CN'})
 page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000)
 await page.route('**/*',route=>{network.push(route.request().url());return route.abort()})
 await page.route('https://admin.fixture.invalid/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body><div id="app"></div></body></html>'}))
 await page.goto('https://admin.fixture.invalid/admin/costs')
 await page.evaluate(({data,balance,user})=>{
  window.__route='/admin/costs';window.__session={id:'fixture-owner',email:'owner@example.invalid',role:'owner'};window.__posts=[]
  window.setInterval=()=>1;window.clearInterval=()=>{}
  window.__request=async(path,body)=>{
   if(path==='session')return window.__session
   if(path.startsWith('costs?'))return structuredClone(data)
   if(path==='provider-balance')return structuredClone(balance)
   if(path==='billing-status')return {enabledProviders:['deepseek'],configured:false}
   if(path.startsWith('users?'))return {rows:[user],hasMore:false,snapshotAt:new Date().toISOString()}
   if(path.startsWith('user?'))return {profile:user,wallet:{balance:1000,reserved_characters:100,lifetime_credited:1000,lifetime_debited:0,lifetime_adjusted_down:0},ledger:[],orders:[],devices:[]}
   if(path==='mutate'){
    if(body.action!=='cost.reconcile')throw Error('Wallet mutations are not allowed in this fixture')
    window.__posts.push(structuredClone(body))
    return {...body.data,provider:body.target,officialUsdExact:body.data.officialUsd,calculated:{},status:'incomplete',comparisonReason:'local_account_scope_unavailable'}
   }
   throw Error('Unexpected fixture route: '+path)
  }
 },{data,balance:fundingBalanceFixture(),user})
 await page.addScriptTag({content:bundle})
 await page.locator('.adm-official-breakdown>summary').click()
 await page.getByRole('button',{name:'录入账单核对',exact:true}).click()
 const amount=page.getByLabel('账单金额（USD，保留原始精度）',{exact:true})
 const tokens=page.getByLabel('账单 Tokens（没有可留空）',{exact:true})
 const calls=page.getByLabel('账单调用数（没有可留空）',{exact:true})
 assert.equal(await tokens.evaluate(input=>input.required),false)
 assert.equal(await calls.evaluate(input=>input.required),false)
 assert.equal(await amount.evaluate(input=>input.required),true)
 await amount.fill('2.66')
 await page.getByLabel('账单来源或导出文件名称',{exact:true}).fill('用户指定当前金额；本次未提供官方明细（本地样例）')
 await page.getByLabel('操作原因',{exact:true}).fill('本地检查仅金额录入，不更改用户钱包')
 await page.getByRole('button',{name:'下一步：核对修改',exact:true}).click()
 await page.getByRole('heading',{name:'请核对本次修改',exact:true}).waitFor()
 checks.push('Amount-only statement reaches review with blank optional numeric fields')
 assert.equal((await page.evaluate(()=>window.__posts)).length,0)
 await page.screenshot({path:directory+'/amount-only-review.png',fullPage:true})
 await page.getByRole('button',{name:'确认保存',exact:true}).click()
 await page.getByRole('dialog',{name:'记录详情',exact:true}).waitFor()
 const posts=await page.evaluate(()=>window.__posts)
 assert.equal(posts.length,1)
 assert.equal(posts[0].action,'cost.reconcile');assert.equal(posts[0].target,'deepseek')
 assert.equal(posts[0].data.officialUsd,'2.66')
 assert.equal(posts[0].data.officialTokens,null);assert.equal(posts[0].data.officialRequests,null)
 assert.equal(posts[0].data.timezone,'Asia/Shanghai')
 assert.doesNotThrow(()=>validateMutation(posts[0]))
 checks.push('Existing submit serializes unknown metrics as null and passes real gateway validation')
 await page.getByRole('dialog',{name:'记录详情',exact:true}).getByRole('button',{name:'关闭',exact:true}).click()
 await page.evaluate(()=>window.__navigate('/admin/users'))
 await page.getByRole('button',{name:'查看用户 →',exact:true}).click()
 for(const [button,label,submit] of [['添加字符','添加字符数','添加字符'],['减少字符','减少字符数','下一步：核对修改']]){
  await page.getByRole('button',{name:button,exact:true}).click()
  const input=page.getByLabel(label,{exact:true})
  assert.equal(await input.evaluate(element=>element.required),true)
  await input.fill('')
  if(button==='减少字符')await page.getByLabel('操作原因',{exact:true}).fill('本地必填检查')
  await page.locator('.adm-edit-form').getByRole('button',{name:submit,exact:true}).click()
  assert.equal(await input.evaluate(element=>element.validity.valueMissing),true)
  assert.equal(await page.getByRole('heading',{name:'请核对本次修改',exact:true}).count(),0)
  assert.equal((await page.evaluate(()=>window.__posts)).length,1)
  await page.locator('.adm-edit-form').getByRole('button',{name:'取消',exact:true}).click()
  checks.push(button+' stays required and empty input cannot submit')
 }
 assert.deepEqual(errors,[]);assert.deepEqual(network,[])
 const result={passed:true,at:new Date().toISOString(),fixture:true,productionAccess:false,walletMutations:0,checks,pageErrors:0,externalRequests:0}
 await writeFile(directory+'/results.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({...result,directory}))
}finally{await browser.close()}
