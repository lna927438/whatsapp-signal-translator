// Explicit, read-only smoke check. No scheduler, login or notification is created.
import {writeFile} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'
const args=process.argv.slice(2),option=name=>args[args.indexOf(name)+1]
for(const name of ['--website','--api','--playwright'])if(!args.includes(name)||!option(name))throw new Error('Required: --website URL --api URL --playwright local-module-path; optional --local-fixture.')
const site=new URL(option('--website')),api=new URL(option('--api'))
for(const url of [site,api])if(url.username||url.password||url.protocol!=='https:'&&!['127.0.0.1','localhost'].includes(url.hostname))throw new Error('Only HTTPS or loopback test services are accepted.')
const {chromium}=await import(pathToFileURL(option('--playwright')).href),results=[],browser=await chromium.launch({headless:true,...(args.includes('--edge')?{channel:'msedge'}:{})})
try{
 const endpoint=new URL(args.includes('--local-fixture')?'/__local/health':'/health',api)
 const health=await fetch(endpoint,{redirect:'error',signal:AbortSignal.timeout(15000)}),body=await health.json()
 if(!health.ok||!['realtime-translator-api','hellodog-admin-local'].includes(body.service))throw new Error('API did not return its expected health document.');results.push('API service identity')
 const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.name))
 await page.goto(new URL('/admin',site).href,{waitUntil:'domcontentloaded',timeout:30000})
 await page.getByRole('heading',{name:'登录管理后台',exact:true}).waitFor({timeout:20000})
 if(errors.length)throw new Error('Admin page encountered a runtime error.');results.push('Admin login renders; not only HTTP 200')
 const report={passed:true,checkedAt:new Date().toISOString(),website:site.origin,api:api.origin,results,readOnly:true}
 if(args.includes('--out'))await writeFile(option('--out'),JSON.stringify(report,null,2))
 console.log(JSON.stringify(report))
}catch(error){const report={passed:false,error:String(error),results,checkedAt:new Date().toISOString(),readOnly:true};if(args.includes('--out'))await writeFile(option('--out'),JSON.stringify(report,null,2));console.error(JSON.stringify(report));process.exitCode=1}finally{await browser.close()}
