import {chromium} from 'file:///C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'
import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
const dir=new URL('../verification/admin-live/',import.meta.url);await mkdir(dir,{recursive:true})
const browser=await chromium.launch({headless:true,channel:'msedge'}),page=await browser.newPage({viewport:{width:1440,height:1050}})
const errors=[],checks=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000)
const ok=name=>checks.push(name)
try{
 await page.goto('http://127.0.0.1:5175/admin');await page.getByRole('button',{name:'进入本地测试后台'}).click()
 await page.getByRole('heading',{name:'总览',exact:true}).waitFor();ok('login and overview')
 for(const name of ['套餐','订单','管理员'])assert.equal(await page.getByRole('navigation').getByRole('link',{name,exact:true}).count(),0)
 ok('no packages, payments or extra administrator navigation')
 await page.screenshot({path:new URL('overview-sample.png',dir).pathname.slice(1),fullPage:true})
 await page.getByRole('navigation').getByRole('link',{name:'用户与余额'}).click();await page.getByRole('textbox',{name:'搜索记录'}).fill('customer01@example.invalid');await page.getByRole('button',{name:'搜索',exact:true}).click();await page.getByRole('row').filter({hasText:'customer01@example.invalid'}).getByRole('button',{name:'查看用户 →'}).click()
 await page.getByRole('button',{name:'添加字符',exact:true}).waitFor();
 const balance=async()=>Number((await page.locator('.adm-wallet strong').innerText()).replaceAll(',',''))
 const before=await balance();await page.getByRole('button',{name:'添加字符',exact:true}).click();await page.getByLabel('添加字符数').fill('125');await page.getByRole('button',{name:'添加字符',exact:true}).last().click();await page.waitForFunction(()=>document.querySelector('.adm-notice')?.textContent?.includes('添加字符已完成'))
 await page.waitForTimeout(200);assert.equal(await balance(),before+125);ok('direct addition with optional blank note updates actual wallet')
 let mutationRequests=0;const routePattern='**/api/admin/mutate'
 await page.route(routePattern,async route=>{mutationRequests++;await route.fetch();await route.abort('failed')})
 await page.getByRole('button',{name:'添加字符',exact:true}).click();await page.getByLabel('添加字符数').fill('17');await page.getByRole('button',{name:'添加字符',exact:true}).last().click()
 await page.getByText('暂未确认操作结果，请保留原操作并继续查询。',{exact:true}).waitFor();await page.unroute(routePattern);await page.reload();await page.getByRole('button',{name:'核对原操作'}).click()
 await page.getByText('已确认：添加字符已完成，无需重复操作。',{exact:false}).waitFor();assert.equal(mutationRequests,1);ok('lost response is recovered by lookup without a duplicate addition')
 await page.getByRole('textbox',{name:'搜索记录'}).fill('customer01@example.invalid');await page.getByRole('button',{name:'搜索',exact:true}).click();await page.getByRole('row').filter({hasText:'customer01@example.invalid'}).getByRole('button',{name:'查看用户 →'}).click();await page.locator('.adm-wallet strong').waitFor();assert.equal(await balance(),before+142)
 await page.getByRole('dialog').getByRole('button',{name:'关闭'}).click()
 let polls=0;page.on('response',response=>{if(response.url().includes('/api/admin/users?'))polls++});await page.waitForTimeout(5500);assert.ok(polls>=1);ok('automatic live refresh')
 await page.getByRole('navigation').getByRole('link',{name:'翻译对账'}).click();await page.getByRole('button',{name:'详情',exact:true}).first().click();await page.getByText('核算状态',{exact:true}).waitFor();assert.ok((await page.getByRole('dialog').innerText()).includes('历史用量未记录'));ok('historical usage is unpriced, not zero');await page.getByRole('dialog').getByRole('button',{name:'关闭'}).click()
 await page.getByRole('navigation').getByRole('link',{name:'用量与费用'}).click();await page.getByRole('heading',{name:'费用计算依据'}).waitFor();await page.getByText('当前金额不代表完整账期总费用。',{exact:false}).waitFor();await page.screenshot({path:new URL('costs-sample.png',dir).pathname.slice(1),fullPage:true});ok('actual usage, missing history and unit cost displayed separately')
 await page.getByLabel('API 服务').selectOption('openai');await page.getByRole('button',{name:'查询用量'}).click();await page.getByRole('button',{name:'核对官方账单'}).click();await page.getByLabel('官方账单费用').fill('0.000012345');await page.getByLabel('官方总 Tokens').fill('300');await page.getByLabel('官方请求数').fill('34');await page.getByLabel('账单来源').fill('QA sample bill only');await page.getByLabel('操作原因').fill('本地核对测试');await page.getByRole('button',{name:'下一步：核对修改'}).click();await page.getByRole('button',{name:'确认保存'}).click();await page.getByText('缺少历史明细',{exact:true}).waitFor();ok('official statement reconciliation preserves incompleteness');await page.getByRole('dialog').getByRole('button',{name:'关闭'}).click()
 await page.getByRole('navigation').getByRole('link',{name:'操作记录'}).click();await page.getByRole('cell',{name:'官方账单核对',exact:true}).first().waitFor();ok('audited character grants and bill reconciliation')
 await page.getByRole('navigation').getByRole('link',{name:'管理员账号'}).click();await page.getByRole('heading',{name:'设置新密码'}).waitFor();ok('administrator password setting form')
 await page.setViewportSize({width:390,height:844});await page.getByRole('navigation').getByRole('link',{name:'用量与费用'}).click();await page.getByRole('heading',{name:'费用计算依据'}).waitFor();await page.screenshot({path:new URL('mobile-sample.png',dir).pathname.slice(1),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));ok('mobile layout has no page overflow')
 assert.deepEqual(errors,[]);ok('no browser runtime errors')
 await writeFile(new URL('browser-result.json',dir),JSON.stringify({checks,errors,sampleData:true},null,2));process.stdout.write(JSON.stringify({passed:checks.length,errors})+'\n')
}catch(e){await page.screenshot({path:new URL('browser-failure.png',dir).pathname.slice(1),fullPage:true});throw e}finally{await browser.close()}
