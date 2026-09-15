import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {balanceRpcResponse} from './deepseek-balance-fixture.ts'

// Use the actual workerd runtime already pinned by the website's Wrangler.
// Every outbound request is handled locally, with synthetic keys and balances.
test('workerd accepts billing fetch options and rejects redirects without credential forwarding',async()=>{
 const websiteRequire=createRequire(new URL('../website/package.json',import.meta.url))
 const runtimeRequire=createRequire(websiteRequire.resolve('wrangler'))
 const {Miniflare,convertV4MiniflareOptions}=runtimeRequire('miniflare'),{build}=runtimeRequire('esbuild')
 const bundle=await build({stdin:{sourcefile:'billing-runtime.ts',resolveDir:fileURLToPath(new URL('../',import.meta.url)),contents:`
  import {syncOfficialCosts,syncDeepSeekBalance} from './server/worker/src/billingSync.ts';
  import {supabaseAdminServices} from './server/worker/src/admin.ts';
  const env={SUPABASE_URL:'https://billing-db.invalid',SUPABASE_SECRET_KEY:'test-db',SUPABASE_PUBLISHABLE_KEY:'test-public',
   OPENAI_BILLING_ADMIN_KEY:'test-admin',OPENAI_BILLING_PROJECT_ID:'proj_test',OPENAI_BILLING_API_KEY_IDS:'key_test',DEEPSEEK_API_KEY:' test-deepseek '};
  export default {async fetch(request){
   const operation=new URL(request.url).pathname.slice(1);
   try {
    if(operation==='legacy'){new Request('https://fixture.invalid',{redirect:'error'});return Response.json({unexpected:true});}
    const result=operation==='openai'?await syncOfficialCosts(env,{from:'2026-09-14',to:'2026-09-14'},Date.parse('2026-09-16T00:00:00Z')):
     operation==='deepseek'?await syncDeepSeekBalance(env):await supabaseAdminServices(env).providerBalance();
    return Response.json(result.sync?.status==='error'?{ok:false,code:result.sync.lastError}:{ok:true,provider:result.provider});
   }catch(error){return Response.json({ok:false,name:error.name,code:error.code,redirectError:/redirect/i.test(error.message)});}
  }};
 `},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'})
 let redirect=false;const calls:Array<{host:string;path:string;authorization:string|null;body?:string}>=[]
 const runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-09-09',outboundService:async(request:Request)=>{
  const url=new URL(request.url),body=request.method==='POST'?await request.text():undefined
  calls.push({host:url.hostname,path:url.pathname,authorization:request.headers.get('Authorization'),body})
  if(url.hostname==='billing-db.invalid')return balanceRpcResponse(request.url,body||'')||Response.json({})
  assert.ok(['api.openai.com','api.deepseek.com'].includes(url.hostname),'No redirects or live network requests permitted')
  if(redirect)return new Response(null,{status:302,headers:{Location:'https://unrelated.invalid/collect'}})
  if(url.hostname==='api.deepseek.com')return Response.json({is_available:true,balance_infos:[{currency:'USD',total_balance:'1',granted_balance:'0',topped_up_balance:'1'}]})
  const start=Date.parse('2026-09-14T00:00:00Z')/1000
  return Response.json({object:'page',has_more:false,data:[{object:'bucket',start_time:start,end_time:start+86400,results:[]}]})
 }}))
 try{
  const legacy=await (await runtime.dispatchFetch('https://fixture.invalid/legacy')).json()
  assert.equal(legacy.name,'TypeError');assert.equal(legacy.redirectError,true);assert.equal(calls.length,0)
  for(const operation of ['openai','deepseek','admin']){
   calls.length=0;redirect=false
   const result=await (await runtime.dispatchFetch('https://fixture.invalid/'+operation)).json()
   assert.equal(result.ok,true,`${operation} succeeds in actual workerd`)
   assert.equal(calls.length,operation==='openai'?2:3)
   assert.equal(calls.find(x=>x.host.startsWith('api.'))?.authorization,operation==='openai'?'Bearer test-admin':'Bearer test-deepseek')
   calls.length=0;redirect=true
   const blocked=await (await runtime.dispatchFetch('https://fixture.invalid/'+operation)).json()
   assert.equal(blocked.ok,false);assert.match(blocked.code,/unavailable/)
   assert.equal(calls.filter(x=>x.host.startsWith('api.')).length,1,`${operation} must not follow the redirect`)
   const finish=calls.find(x=>x.path.endsWith('finish_deepseek_balance_refresh'))
   if(operation!=='openai'){assert.ok(finish);assert.equal(JSON.parse(finish.body!).p_result,null)}
   assert.ok(!calls.some(x=>x.path.endsWith('record_official_bill')))
  }
 }finally{await runtime.dispose()}
})
