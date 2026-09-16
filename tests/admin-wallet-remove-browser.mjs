import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {randomUUID} from 'node:crypto'
import {mkdir,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
const {chromium}=createRequire(import.meta.url)('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const base='http://127.0.0.1:5187',directory=fileURLToPath(new URL('../verification/admin-wallet-20260917/',import.meta.url))
const health=await fetch(base+'/__local/health').then(r=>r.json());assert.equal(health.service,'hellodog-admin-local');assert.equal(health.sampleData,true)
await mkdir(directory,{recursive:true})
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1365,height:1000}})
const errors=[],checks=[],posts=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(12000)
page.on('request',request=>{if(request.url().endsWith('/api/admin/mutate'))posts.push(request.postDataJSON())})
const userId='30000000-0000-4000-8000-000000000001'
async function read(){return page.evaluate(async({base,userId})=>{const r=await fetch(base+'/api/admin/user?userId='+userId,{headers:{Authorization:'Bearer '+sessionStorage.getItem('hellodog-admin-local-token')}});if(!r.ok)throw Error('fixture read');return r.json()},{base,userId})}
async function open(){await page.getByRole('navigation').getByRole('link',{name:'用户与余额'}).click();await page.getByRole('textbox',{name:'搜索记录'}).fill('customer01@example.invalid');await page.getByRole('button',{name:'搜索',exact:true}).click();await page.getByRole('row').filter({hasText:'customer01@example.invalid'}).getByRole('button',{name:'查看用户 →'}).click();await page.getByRole('button',{name:'减少字符',exact:true}).waitFor()}
async function edit(amount,reason='更正本地测试重复入账'){await page.getByRole('button',{name:'减少字符',exact:true}).click();await page.getByLabel('减少字符数').fill(String(amount));await page.getByLabel('操作原因').fill(reason)}
async function confirm(){await page.getByRole('button',{name:'下一步：核对修改'}).click();await page.getByRole('button',{name:'确认减少字符',exact:true}).click()}
try{
 await page.goto(base+'/admin');await page.getByRole('button',{name:'进入本地测试后台'}).click();await page.getByRole('heading',{name:'总览',exact:true}).waitFor();await open()
 const before=await read();await edit(25,'');await page.getByRole('button',{name:'下一步：核对修改'}).click();assert.equal(posts.length,0);assert.equal(await page.getByRole('button',{name:'确认减少字符',exact:true}).count(),0);checks.push('required reason prevents accidental reduction')
 await page.getByLabel('操作原因').fill('更正本地测试重复入账');await page.getByRole('button',{name:'下一步：核对修改'}).click();const review=page.getByRole('dialog').last();assert.match(await review.innerText(),/本次减少：25/);assert.match(await review.innerText(),/不计入翻译使用量/);await page.screenshot({path:directory+'/review.png',fullPage:true})
 await page.getByRole('button',{name:'确认减少字符',exact:true}).click();await page.getByText('减少字符已完成',{exact:false}).waitFor();const reduced=await read();assert.equal(reduced.wallet.balance,before.wallet.balance-25);assert.equal(reduced.wallet.lifetime_debited,before.wallet.lifetime_debited);assert.equal(reduced.wallet.lifetime_adjusted_down,before.wallet.lifetime_adjusted_down+25);checks.push('real UI to gateway to database reduction, journal and unchanged translation usage')
 await edit(10);await page.getByRole('button',{name:'下一步：核对修改'}).click()
 const concurrent={operationId:randomUUID(),action:'wallet.add',target:userId,reason:'本地并发充值测试',data:{amount:3}}
 await page.evaluate(async op=>{const r=await fetch('/api/admin/mutate',{method:'POST',headers:{Authorization:'Bearer '+sessionStorage.getItem('hellodog-admin-local-token'),'Content-Type':'application/json'},body:JSON.stringify(op)});if(!r.ok)throw Error('fixture add')},concurrent)
 await page.getByRole('button',{name:'确认减少字符',exact:true}).click();await page.getByText('余额或翻译预留已变化，已刷新最新余额。请重新核对减少数。',{exact:true}).waitFor();assert.equal((await read()).wallet.balance,reduced.wallet.balance+3);checks.push('concurrent balance change is refused and rereview uses refreshed balance')
 await confirm();await page.getByText('减少字符已完成',{exact:false}).waitFor();assert.equal((await read()).wallet.balance,reduced.wallet.balance-7)
 const priorPosts=posts.length,route='**/api/admin/mutate';await page.route(route,async r=>{await r.fetch();await r.abort('failed')})
 await edit(7);await confirm();await page.getByText('暂未确认操作结果，请保留原操作并继续查询。',{exact:true}).waitFor();await page.unroute(route);const operationId=posts.at(-1).operationId
 await page.reload();await page.getByRole('button',{name:'核对原操作'}).click();await page.locator('.adm-notice').filter({hasText:'已确认：减少字符已完成，无需重复操作。'}).waitFor();assert.equal(posts.length,priorPosts+1);const afterLost=await read();assert.equal(afterLost.wallet.balance,reduced.wallet.balance-14);assert.equal(afterLost.ledger.filter(x=>x.idempotency_key==='admin:'+operationId).length,1);checks.push('lost response survives reload and recovers by original operation without resending')
 await open();await page.screenshot({path:directory+'/user-detail.png',fullPage:true});await page.getByRole('dialog').getByRole('button',{name:'关闭'}).click();await page.getByRole('navigation').getByRole('link',{name:'操作记录'}).click();await page.getByRole('cell',{name:'减少字符',exact:true}).first().waitFor();checks.push('reductions visible in immutable operation history')
 await page.setViewportSize({width:390,height:844});await open();await edit(1);await page.screenshot({path:directory+'/mobile-editor.png',fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));checks.push('mobile form remains within viewport')
 assert.deepEqual(errors,[]);checks.push('no browser runtime errors')
 await writeFile(directory+'/browser-result.json',JSON.stringify({passed:true,sampleData:true,checks,errors,verifiedAt:new Date().toISOString()},null,2));console.log(JSON.stringify({passed:checks.length,errors}))
}catch(error){await page.screenshot({path:directory+'/failure.png',fullPage:true});throw error}finally{await browser.close()}
