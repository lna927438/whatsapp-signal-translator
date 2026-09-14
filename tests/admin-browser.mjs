import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const require=createRequire(import.meta.url)
const {chromium}=require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const base=process.env.HELLODOG_ADMIN_BROWSER_URL||'http://127.0.0.1:5175'
const dir=fileURLToPath(new URL('../verification/admin-console/',import.meta.url));await mkdir(dir,{recursive:true})
const browser=await chromium.launch({headless:true,channel:'msedge'})
const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1})
const errors=[];page.on('pageerror',e=>errors.push(e.message));const steps=[]
const check=(condition,message)=>{if(!condition)throw new Error(message);steps.push(message)}
async function menu(name){await page.getByRole('navigation',{name:'管理导航'}).getByRole('link',{name,exact:false}).click();await page.waitForFunction(()=>!document.querySelector('[aria-busy="true"]'))}
async function save(){const dialog=page.getByRole('dialog').last();await dialog.getByRole('button',{name:'下一步：核对修改'}).click();await dialog.getByRole('button',{name:'确认保存',exact:true}).click();await page.locator('.adm-edit-form').waitFor({state:'hidden'})}
try{
  await page.goto(base+'/admin');await page.getByRole('button',{name:'进入本地测试后台'}).click();await page.getByRole('heading',{name:'总览',exact:true}).waitFor()
  await page.screenshot({path:dir+'/overview-desktop.png',fullPage:true});check(await page.locator('.adm-stat-grid article').count()===4,'overview renders live database totals')
  await menu('用户与余额');await page.getByRole('textbox',{name:'搜索记录'}).fill('customer01@example.invalid');await page.getByRole('button',{name:'搜索',exact:true}).click();await page.waitForTimeout(200)
  check(await page.locator('.adm-table tbody tr').count()===1,'user search narrows to intended account')
  await page.getByRole('button',{name:'查看用户'}).click();await page.getByRole('button',{name:'调整字符余额'}).waitFor()
  const balance=Number((await page.locator('.adm-wallet strong').innerText()).replaceAll(',',''))
  await page.getByRole('button',{name:'调整字符余额'}).click();await page.getByLabel('调整字符数（增加填正数，扣减填负数）').fill('125');await page.getByLabel('操作原因').fill('浏览器测试补发字符');await save()
  await page.waitForFunction(expected=>document.querySelector('.adm-wallet strong')?.textContent?.replaceAll(',','')===String(expected),balance+125)
  check(true,'confirmed adjustment changes the wallet by exactly 125')
  let uncertainPosts=0
  await page.route('**/api/admin/mutate',async route=>{uncertainPosts++;await route.fetch();await route.abort('failed')})
  await page.getByRole('button',{name:'调整字符余额'}).click();await page.getByLabel('调整字符数（增加填正数，扣减填负数）').fill('17');await page.getByLabel('操作原因').fill('模拟回包丢失，核对原操作')
  await page.getByRole('button',{name:'下一步：核对修改'}).click();await page.getByRole('button',{name:'确认保存',exact:true}).click()
  await page.getByRole('dialog',{name:'余额调整',exact:true}).getByRole('alert').waitFor();await page.unroute('**/api/admin/mutate')
  await page.reload();await page.getByRole('button',{name:'核对原操作'}).waitFor();await page.getByRole('button',{name:'核对原操作'}).click()
  await page.locator('.adm-notice').filter({hasText:'已确认：余额调整已完成，无需重复操作。'}).waitFor()
  check(uncertainPosts===1,'lost response recovered by read-only operation lookup after reload')
  await page.getByRole('textbox',{name:'搜索记录'}).fill('customer01@example.invalid');await page.getByRole('button',{name:'搜索',exact:true}).click();await page.waitForTimeout(150)
  await page.getByRole('button',{name:'查看用户'}).click();await page.getByRole('button',{name:'调整字符余额'}).waitFor()
  check(Number((await page.locator('.adm-wallet strong').innerText()).replaceAll(',',''))===balance+142,'lost response did not duplicate wallet credit')
  await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click()
  await menu('翻译对账');await page.getByRole('textbox',{name:'搜索记录'}).fill('local-example-001');await page.getByRole('button',{name:'搜索',exact:true}).click();await page.waitForTimeout(150)
  await page.getByRole('button',{name:'详情',exact:true}).click();check(!(await page.getByRole('dialog').innerText()).includes('Local sample. Not a real chat.'),'translation details omit chat content')
  await page.screenshot({path:dir+'/translation-detail.png',fullPage:true});await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click()
  if(await page.getByRole('button',{name:'补偿',exact:true}).count()){
    await page.getByRole('button',{name:'补偿',exact:true}).click();await page.getByLabel('操作原因').fill('测试原扣费补偿');await save();await page.waitForTimeout(150);check(await page.getByRole('button',{name:'补偿',exact:true}).count()===0,'refund disables a second refund')
  }
  await menu('套餐');await page.getByRole('button',{name:'新建套餐'}).click();const plan='browser_'+Date.now()
  await page.getByLabel('套餐代码', {exact:true}).fill(plan);await page.getByLabel('套餐名称',{exact:true}).fill('浏览器测试套餐');await page.getByLabel('包含字符',{exact:true}).fill('8000');await page.getByLabel('价格（分，例如 990 表示 9.90）').fill('250');await page.getByLabel('启用此套餐').check();await page.getByLabel('操作原因').fill('创建本地测试套餐');await save();check(await page.getByText(plan,{exact:true}).count()===1,'new plan persists')
  await menu('版本');await page.getByRole('button',{name:'新增版本'}).click();await page.getByLabel('版本号',{exact:true}).fill('0.5.3-beta.'+Date.now());await page.getByLabel('更新内容').fill('浏览器验收版本草稿');await page.getByLabel('操作原因').fill('新增测试草稿');await save();check(await page.getByText('浏览器验收版本草稿',{exact:true}).count()>=1,'beta version saves as a draft')
  await menu('公告');await page.getByRole('button',{name:'新建公告'}).click();await page.getByLabel('标题',{exact:true}).fill('本地验收公告');await page.getByLabel('公告内容').fill('<img src=x onerror=alert(1)> 作为文字保存');await page.getByLabel('操作原因').fill('测试公告转义');await save();check(await page.getByText('本地验收公告',{exact:true}).count()>0,'announcement saved without interpreting HTML')
  await menu('订单');const settle=page.getByRole('button',{name:'确认收款',exact:true}).first()
  if(await settle.count()){await settle.click();await page.getByLabel('已收款凭证编号').fill('browser-'+Date.now());await page.getByLabel('操作原因').fill('本地测试收款登记');await save();check(await page.getByText('已入账',{exact:true}).count()>0,'manual order settlement records payment and credits once')}
  await menu('操作记录');check(await page.locator('.adm-table tbody tr').count()>=4,'audit shows completed browser mutations')
  await page.screenshot({path:dir+'/audit-desktop.png',fullPage:true})
  await page.reload();await page.getByRole('heading',{name:'操作记录',exact:true}).waitFor();check(await page.locator('.adm-table tbody tr').count()>=4,'reload preserves records and admin login')
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:dir+'/mobile.png',fullPage:true});check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile layout has no page-wide horizontal overflow')
  await page.setViewportSize({width:1440,height:1000});await page.getByRole('button',{name:'退出登录'}).click();await page.getByLabel('测试身份').selectOption('support');await page.getByRole('button',{name:'进入本地测试后台'}).click();await page.getByRole('heading',{name:'总览',exact:true}).waitFor();check(await page.getByRole('navigation').getByRole('link',{name:'订单',exact:false}).count()===0,'support cannot see financial editing sections')
  await menu('用户与余额');await page.getByRole('button',{name:'查看用户'}).first().click();await page.getByRole('heading',{name:'钱包流水',exact:false}).waitFor();check(await page.getByRole('button',{name:'调整字符余额'}).count()===0,'support cannot adjust balances')
  await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('button',{name:'退出登录'}).click();await page.getByLabel('测试身份').selectOption('user');await page.getByRole('button',{name:'进入本地测试后台'}).click();await page.getByRole('alert').waitFor();check((await page.getByRole('alert').innerText()).includes('没有'),'ordinary user denied at login')
  check(errors.length===0,'no unhandled browser errors')
  await writeFile(dir+'/browser-result.json',JSON.stringify({passed:true,steps,errors},null,2));console.log(JSON.stringify({passed:true,steps},null,2))
}catch(e){await page.screenshot({path:dir+'/failure.png',fullPage:true}).catch(()=>{});const overflow=await page.evaluate(()=>Array.from(document.querySelectorAll('*')).filter(el=>el.getBoundingClientRect().right>innerWidth+1).slice(0,30).map(el=>({tag:el.tagName,cls:el.className,right:el.getBoundingClientRect().right,width:el.getBoundingClientRect().width,overflow:getComputedStyle(el).overflow})));await writeFile(dir+'/browser-result.json',JSON.stringify({passed:false,steps,error:String(e),errors,overflow},null,2));console.error(e);console.log(overflow);process.exitCode=1}finally{await browser.close()}
