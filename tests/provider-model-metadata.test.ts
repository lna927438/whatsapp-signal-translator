import {test} from 'node:test'
import assert from 'node:assert/strict'
import {providerCapabilities,requestProviderPlan} from '../server/worker/src/providerConfig.ts'
import {supabaseAdminServices} from '../server/worker/src/admin.ts'
import worker,{type Env} from '../server/worker/src/index.ts'
import {adminTranslationChannel} from '../website/src/admin/translationChannels.ts'

const env:Env={API_RATE_LIMITER:{limit:async()=>({success:true})},SUPABASE_URL:'https://fixture.invalid',SUPABASE_PUBLISHABLE_KEY:'public',SUPABASE_SECRET_KEY:'private',
  TRANSLATION_PROVIDER:'deepseek',TRANSLATION_SELECTABLE_PROVIDERS:'deepseek,openai',DEEPSEEK_API_KEY:'fixture-deepseek-secret',OPENAI_API_KEY:'fixture-openai-secret',
  DEEPSEEK_MODEL:'deepseek-v4-pro',OPENAI_MODEL:'gpt-5.6-luna'}

test('health publishes full exact configured model identities independent of selectable key status',async()=>{
  const configured={...env,OPENAI_MODEL:' gpt-5.6-luna-2026-09-22 ',DEEPSEEK_MODEL:'deepseek-v4-pro',OPENAI_API_KEY:undefined}
  const response=await worker.fetch(new Request('https://worker.invalid/health'),configured),data:any=await response.json()
  assert.deepEqual(data.translationModels,{openai:{model:'gpt-5.6-luna-2026-09-22',displayName:'gpt-5.6-luna-2026-09-22'},deepseek:{model:'deepseek-v4-pro',displayName:'deepseek-v4-pro'}})
  assert.deepEqual(data.translationProviders,['deepseek']);assert.equal(data.defaultTranslationProvider,'deepseek')
  assert.equal(data.routing[0].model,data.translationModels.deepseek.model)
  assert.doesNotMatch(JSON.stringify(data),/fixture-.*-secret|baseUrl|API_KEY/)
  assert.throws(()=>requestProviderPlan(configured,'openai'),/provider_not_available/)
})

test('credential-like or invalid model settings never leak through public metadata or health routing',async()=>{
  for(const model of ['sk-proj-secret-placeholder',env.DEEPSEEK_API_KEY!,env.OPENAI_API_KEY!,'bad\nmodel','<script>alert(1)</script>']){
    const configured={...env,TRANSLATION_PROVIDER:'openai',OPENAI_MODEL:model}
    const response=await worker.fetch(new Request('https://worker.invalid/health'),configured),data:any=await response.json()
    assert.deepEqual(data.translationModels.openai,{model:'',displayName:''})
    assert.equal(data.model,'');assert.equal(data.routing[0].model,'');assert.deepEqual(data.translationProviders,['deepseek'])
    assert.equal(JSON.stringify(data).includes(model),false)
  }
})

test('admin non-owner costs get current channel metadata without official statements or extra I/O',async t=>{
  let calls=0
  const historical={totals:{known_cost_usd_exact:'0.02'},providers:[{provider:'openai',known_cost_usd_exact:'0.02'}],models:[{provider:'openai',model:'old-model',cost_usd_exact:'0.02'}]}
  t.mock.method(globalThis,'fetch',async(input:string|URL|Request,init?:RequestInit)=>{calls++;assert.equal(String(input),env.SUPABASE_URL+'/rest/v1/rpc/admin_read');assert.equal(JSON.parse(String(init?.body)).p_kind,'costs');return Response.json(historical)})
  const data:any=await supabaseAdminServices(env).rpc('admin_read',{p_actor:'fixture-owner',p_kind:'costs',p_filter:{}})
  assert.equal(calls,1);assert.deepEqual(data.models,historical.models);assert.deepEqual(data.totals,historical.totals)
  assert.deepEqual(data.translationModels,providerCapabilities(env).translationModels);assert.deepEqual(data.translationProviders,['deepseek','openai'])
  assert.equal(Object.hasOwn(data,'officialBills'),false);assert.doesNotMatch(JSON.stringify(data),/fixture-.*-secret/)
})

test('admin routing capability does not imply ordinary inference keys can read official costs',async t=>{
  t.mock.method(globalThis,'fetch',async()=>assert.fail('No billing scope means no official provider or database requests'))
  const status:any=await supabaseAdminServices(env).billingStatus!()
  assert.equal(status.configured,false);assert.equal(status.reason,'admin_key_missing')
  assert.deepEqual(status.translationProviders,['deepseek','openai']);assert.equal(status.translationModels.openai.model,'gpt-5.6-luna')
})

test('admin channel labels distinguish current metadata, retired selection, failed refresh and missing fields',()=>{
  const current=providerCapabilities(env)
  assert.deepEqual(adminTranslationChannel(current,'deepseek'),{model:'deepseek-v4-pro',available:true,status:'已开放选择',isDefault:true})
  assert.deepEqual(adminTranslationChannel({...current,translationProviders:['deepseek']},'openai'),{model:'gpt-5.6-luna',available:false,status:'未开放选择',isDefault:false})
  assert.equal(adminTranslationChannel(current,'openai',true).status,'状态待重新确认')
  assert.equal(adminTranslationChannel(current,'openai',true).available,false)
  assert.deepEqual(adminTranslationChannel({},'openai'),{model:'',available:false,status:'状态尚未取得',isDefault:false})
  assert.equal(adminTranslationChannel({...current,translationModels:{openai:{model:'gpt-real',displayName:'gpt-made-up'}}},'openai').model,'')
  assert.equal(adminTranslationChannel({...current,translationProviders:['openai','unknown']},'openai').available,false)
})
