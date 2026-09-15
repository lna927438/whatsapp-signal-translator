import {before,after,beforeEach,test} from 'node:test'
import assert from 'node:assert/strict'
import worker,{type Env} from '../server/worker/src/index.ts'
import {database,reset,asRole,rpc,wallet,USER} from '../tests/fixture.ts'
import {mainHarness} from './main-harness.ts'
import {rmSync} from 'node:fs'
const desktop=mainHarness()
const {hasBlockedChinese}=desktop.load('src/main/translation/outgoingPolicy.ts')
const {validateTranslation}=desktop.load('src/main/translation/translationValidation.ts')
let db:Awaited<ReturnType<typeof database>>,output:(provider:string,body:any)=>string=()=>'',calls:string[]=[]
const originalFetch=globalThis.fetch
const env:Env={API_RATE_LIMITER:{limit:async()=>({success:true})},SUPABASE_URL:'https://database.invalid',SUPABASE_PUBLISHABLE_KEY:'fixture-public',SUPABASE_SECRET_KEY:'fixture-service',TRANSLATION_PROVIDER:'openai',TRANSLATION_FALLBACK_PROVIDER:'deepseek',OPENAI_API_KEY:'fixture-openai',OPENAI_MODEL:'gpt-5.6-luna',DEEPSEEK_API_KEY:'fixture-deepseek',DEEPSEEK_MODEL:'deepseek-v4-pro'}
const reply=(body:unknown,status=200)=>Response.json(body,{status})
const signatures:Record<string,string[]>={provider_route_acquire:['p_user_id','p_request_id','p_claim_token','p_provider','p_model'],provider_route_outcome:['p_user_id','p_request_id','p_claim_token','p_provider','p_model','p_generation','p_probe_token','p_success','p_error_code']}
before(async()=>{
 db=await database()
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input)),headers=new Headers(init?.headers)
  if(['https://api.openai.com','https://api.deepseek.com'].includes(url.origin)){
   calls.push(url.origin)
   const body=JSON.parse(String(init?.body))
   return reply({id:'synthetic-response',model:body.model,status:'completed',output_text:output(url.origin,body),service_tier:'default',usage:{input_tokens:40,input_tokens_details:{cached_tokens:0,cache_write_tokens:0},output_tokens:8,output_tokens_details:{reasoning_tokens:0},total_tokens:48}})
  }
  assert.equal(url.origin,env.SUPABASE_URL,'No live network destination is permitted')
  if(url.pathname==='/auth/v1/user')return reply({id:USER})
  assert.equal(headers.get('apikey'),'fixture-service')
  if(url.pathname==='/rest/v1/profiles')return reply((await asRole(db,'service_role','select * from public.profiles where id=$1',[USER])).rows)
  assert.ok(url.pathname.startsWith('/rest/v1/rpc/'))
  const name=url.pathname.split('/').at(-1)!,args=JSON.parse(String(init?.body))
  try{
   const names=signatures[name]
   return reply(names?(await asRole<any>(db,'service_role','select public.'+name+'('+names.map((_,i)=>'$'+(i+1)).join(',')+') r',names.map(key=>args[key]))).rows[0].r:await rpc(db,name,args))
  }catch(error:any){return reply({message:error.message},400)}
 }
})
beforeEach(async()=>{await reset(db);await db.exec('delete from translator_private.provider_circuits');calls=[];output=()=>good})
after(async()=>{globalThis.fetch=originalFetch;await db.close();rmSync(desktop.directory,{recursive:true,force:true})})
const text='我明天会给你回复。',good="I'll reply to you tomorrow."
async function translate(id:string,patch:Record<string,unknown>={},headerOnly=false){
 const response=await worker.fetch(new Request('https://worker.invalid/api/translate',{method:'POST',headers:{Authorization:'Bearer fixture-user','Content-Type':'application/json','x-request-id':id},body:JSON.stringify({...(headerOnly?{}:{requestId:id}),text,sourceLanguage:'zh-CN',targetLanguage:'en-US',...patch})}),env)
 return {status:response.status,body:await response.json() as any}
}
async function debitCount(){return (await db.query<{n:number}>("select count(*)::int n from public.character_ledger where type='translation'")).rows[0].n}
for(const [name,bad] of [['Chinese',text],['Spanish','Hola, gracias, estoy bien y tengo tiempo.'],['French','Bonjour, merci, vous êtes très bien.']]){
 test(name+' primary output for English target falls back before one character settlement',async()=>{
  output=provider=>provider==='https://api.openai.com'?bad:good
  const result=await translate('send-audit-'+name)
  assert.equal(result.status,200);assert.equal(result.body.translation,good)
  assert.deepEqual(calls,['https://api.openai.com','https://api.deepseek.com'])
  assert.equal((await wallet(db)).lifetime_debited,Array.from(text).length);assert.equal(await debitCount(),1)
  assert.equal(hasBlockedChinese(result.body.translation,'en-US'),false)
  assert.equal(validateTranslation({text,targetLanguage:'en-US'},result.body.translation),good)
  const errors=(await db.query("select error_code from translator_private.provider_attempt_usage order by attempt_index")).rows
  assert.deepEqual(errors,[{error_code:'provider_wrong_language'},{error_code:null}])
 })
}
test('two wrong-language provider answers are terminal and never debit, including replay',async()=>{
 output=()=>text
 const result=await translate('send-audit-both-wrong')
 assert.equal(result.body.error,'translation_failed');assert.notEqual(result.status,200)
 assert.deepEqual(await wallet(db),{balance:100,reserved_characters:0,lifetime_debited:0});assert.equal(await debitCount(),0)
 const replay=await translate('send-audit-both-wrong')
 assert.equal(replay.body.error,'translation_failed');assert.equal(calls.length,2);assert.equal(await debitCount(),0)
})
test('general translation also rejects clear Chinese output for English before paying the primary',async()=>{
 output=provider=>provider==='https://api.openai.com'?text:good
 const result=await translate('audit-generic-wrong')
 assert.equal(result.body.translation,good);assert.equal(calls.length,2);assert.equal(await debitCount(),1)
})
test('ambiguous capitalized names remain valid for a Chinese target',async()=>{
 output=()=>'Tom Smith'
 const result=await translate('audit-proper-name',{text:'Tom Smith',sourceLanguage:'auto',targetLanguage:'zh-CN'})
 assert.equal(result.status,200);assert.equal(result.body.translation,'Tom Smith');assert.equal(calls.length,1)
})
for(const [target,value] of [['zh-CN','我是张三，我们明天见。'],['ja','私は田中です。明日お会いしましょう。'],['ja','明日午後']]){
 test('legitimate '+target+' output remains chargeable: '+value,async()=>{
  output=()=>value
  const result=await translate('send-audit-valid-'+target,{text:'See you tomorrow.',sourceLanguage:'en-US',targetLanguage:target})
  assert.equal(result.status,200);assert.equal(result.body.translation,value);assert.equal(calls.length,1);assert.equal(await debitCount(),1)
 })
}
test('protected foreign glossary and URL do not pollute the general translation language sample',async()=>{
 output=(_provider,body)=>'Please open '+body.input.match(/__HDPROTECTED_\d+__/g).join(' and contact ')+'.'
 const result=await translate('audit-literals',{text:'请打开 https://example.test/消息 并联系 HelloDog',quality:{glossary:[{source:'HelloDog',target:'HelloDog'}]}})
 assert.equal(result.status,200);assert.ok(result.body.translation.includes('https://example.test/消息'));assert.ok(result.body.translation.includes('HelloDog'));assert.equal(calls.length,1)
})
test('an outgoing Chinese URL retained by both providers cannot be charged then rejected by desktop',async()=>{
 output=(_provider,body)=>'Please open '+body.input.match(/__HDPROTECTED_\d+__/g).join(' ')+'.'
 const result=await translate('send-audit-url',{text:'请打开 https://example.test/消息'})
 assert.equal(result.body.error,'translation_failed');assert.equal(calls.length,2);assert.equal(await debitCount(),0)
})
test('an outgoing protected Chinese glossary term is rejected before charge without rewriting it',async()=>{
 output=(_provider,body)=>'Please contact '+body.input.match(/__HDPROTECTED_\d+__/g).join(' ')+'.'
 const result=await translate('send-audit-term',{text:'请联系 HelloDog',quality:{glossary:[{source:'HelloDog',target:'你好狗'}]}})
 assert.equal(result.body.error,'translation_failed');assert.equal(calls.length,2);assert.equal(await debitCount(),0)
})
test('one mixed Han character is blocked before outgoing charge including legacy header-only ID',async()=>{
 output=provider=>provider==='https://api.openai.com'?'Tomorrow 我 can reply.':good
 const result=await translate('send-audit-header',{},true)
 assert.equal(result.status,200);assert.equal(result.body.translation,good);assert.equal(calls.length,2);assert.equal(await debitCount(),1)
})
test('foreign glossary text that triggers desktop language rejection cannot be charged for an outgoing send',async()=>{
 output=(_provider,body)=>'Received: '+body.input.match(/__HDPROTECTED_\d+__/g).join(' ')
 const result=await translate('send-audit-foreign-glossary',{text:'请说 Greeting',quality:{glossary:[{source:'Greeting',target:'hola gracias usted estoy'}]}})
 assert.equal(result.body.error,'translation_failed');assert.equal(calls.length,2);assert.equal(await debitCount(),0)
 assert.throws(()=>validateTranslation({text:'请说 Greeting',targetLanguage:'en-US'},'Received: hola gracias usted estoy'),/译文语言与目标不符/)
})
test('a Han-only Japanese target that the current desktop rejects is not charged for an outgoing send',async()=>{
 output=()=>'我在東京工作'
 const result=await translate('send-audit-kanji-client',{text:'I work in Tokyo.',sourceLanguage:'en-US',targetLanguage:'ja'})
 assert.equal(result.body.error,'translation_failed');assert.equal(calls.length,2);assert.equal(await debitCount(),0)
 assert.throws(()=>validateTranslation({text:'I work in Tokyo.',targetLanguage:'ja'},'我在東京工作'),/译文语言与目标不符/)
})
