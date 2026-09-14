import {pathToFileURL} from 'node:url'
import {isAbsolute} from 'node:path'
const runtime=process.env.HELLODOG_PLAYWRIGHT_MODULE||'playwright'
const {chromium}=await import(isAbsolute(runtime)?pathToFileURL(runtime).href:runtime)
import {createHmac} from 'node:crypto'
import {writeFile,mkdir} from 'node:fs/promises'
const base=process.env.HELLODOG_ADMIN_TEST_URL||'http://127.0.0.1:5186',results=[],errors=[],mutations=[]
const endpoint=new URL(base)
if(endpoint.protocol!=='http:'||!['localhost','127.0.0.1'].includes(endpoint.hostname))throw new Error('An isolated loopback admin fixture is required')
const health=await fetch(new URL('/__local/health',endpoint),{redirect:'error'}).then(r=>r.json())
if(health.service!=='hellodog-admin-local')throw new Error('This is not a local admin fixture')
const evidence=new URL('../verification/admin-security-browser/',import.meta.url)
await mkdir(evidence,{recursive:true})
function code(){const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));const h=createHmac('sha1',Buffer.from('48656c6c6f21deadbeef','hex')).update(b).digest(),o=h[19]&15;return String((h.readUInt32BE(o)&0x7fffffff)%1000000).padStart(6,'0')}
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1365,height:950}})
page.on('pageerror',e=>errors.push(e.message))
page.on('response',async response=>{if(response.url().endsWith('/api/admin/mutate'))mutations.push({status:response.status(),body:await response.json()})})
try{
 await page.goto(base+'/admin');await page.getByRole('button',{name:'进入本地测试后台'}).click();await page.getByRole('heading',{name:'保护管理员账号'}).waitFor();results.push('Password-only login cannot enter admin overview')
 await page.getByRole('button',{name:'开始绑定验证器'}).click();await page.getByAltText('请使用验证器扫描绑定二维码').waitFor();await page.getByRole('checkbox').check();await page.getByLabel('验证码',{exact:true}).fill('000000');await page.getByRole('button',{name:'验证并完成绑定'}).click();await page.getByRole('alert').filter({hasText:'验证码无效'}).waitFor();results.push('Invalid TOTP rejected')
 await page.getByLabel('验证码',{exact:true}).fill(code());await page.getByRole('button',{name:'验证并完成绑定'}).click();await page.getByRole('heading',{name:'总览',exact:true}).waitFor();results.push('Verified TOTP opens actual local database overview')
 await page.reload();await page.getByRole('heading',{name:'总览',exact:true}).waitFor();results.push('Refresh preserves verified browser session')
 const token=await page.evaluate(()=>sessionStorage.getItem('hellodog-admin-local-token'))
 await page.request.post(base+'/__local/mfa/expire',{headers:{Origin:base,Authorization:'Bearer '+token}})
 const response=await page.evaluate(async()=>{const token=sessionStorage.getItem('hellodog-admin-local-token');const r=await fetch('/api/admin/security-confirm',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}'});return {status:r.status,body:await r.json()}})
 if(response.status!==403||response.body.error!=='mfa_step_up')throw new Error('Stale TOTP was not rejected');results.push('Stale TOTP cannot authorize a protected write')
 await page.getByRole('link',{name:/安全与保护/}).click();await page.getByRole('heading',{name:'安全与保护',exact:true}).waitFor();await page.screenshot({path:new URL('admin-security.png',evidence).pathname.replace(/^\/([A-Za-z]:)/,'$1'),fullPage:true});results.push('Security dashboard renders without a blank page')
 await page.getByRole('link',{name:/用户与余额/}).click()
 await page.getByRole('row').filter({hasText:'customer01@example.invalid'}).getByRole('button',{name:'查看用户 →'}).click()
 await page.getByRole('button',{name:'清理云端译文',exact:true}).click()
 await page.getByLabel('操作原因',{exact:true}).fill('本地测试用户申请清理缓存')
 await page.getByRole('button',{name:'下一步：核对修改'}).click()
 await page.getByRole('button',{name:'确认保存',exact:true}).click()
 await page.getByRole('heading',{name:'管理员二次验证',exact:true}).waitFor()
 await page.getByLabel('验证码',{exact:true}).fill(code())
 await page.getByRole('button',{name:'验证并继续',exact:true}).click()
 await page.getByRole('heading',{name:'管理员二次验证',exact:true}).waitFor({state:'hidden'})
 await page.getByRole('button',{name:'确认保存',exact:true}).click()
 await page.getByRole('dialog',{name:'清理云端译文',exact:true}).waitFor({state:'hidden'})
 await page.getByRole('dialog',{name:'用户详情'}).getByRole('button',{name:'关闭',exact:true}).click()
 await page.getByRole('status').filter({hasText:'清理云端译文已完成。'}).waitFor()
 results.push('Cloud text cleanup requires fresh MFA and explicit reconfirmation, then succeeds in fixture database')
 await page.getByRole('button',{name:/退出登录/}).click();await page.getByRole('button',{name:'进入本地测试后台'}).waitFor();await page.getByLabel('测试身份').selectOption('user');await page.getByRole('button',{name:'进入本地测试后台'}).click();await page.getByRole('alert').filter({hasText:'当前账号没有此操作的管理权限'}).waitFor()
 if(await page.getByRole('heading',{name:/保护管理员账号|管理员二次验证/}).count())throw new Error('Ordinary user was offered admin MFA')
 results.push('Ordinary account cannot enter administration or enroll as administrator')
 if(errors.length)throw new Error('Browser runtime errors: '+errors.join('; '))
 await writeFile(new URL('mfa-browser-results.json',evidence),JSON.stringify({passed:true,results,errors,mutations},null,2))
 console.log(JSON.stringify({passed:true,results},null,2))
}catch(error){await writeFile(new URL('mfa-browser-results.json',evidence),JSON.stringify({passed:false,results,errors,mutations,alerts:await page.locator('[role="alert"]').allTextContents(),error:String(error)},null,2));throw error}finally{await browser.close()}
