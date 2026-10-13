import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,readdirSync,rmSync,existsSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {mainHarness} from './main-harness.ts'

const encode=(value:unknown,kind='enc')=>kind+':'+Buffer.from(JSON.stringify(value)).toString('base64')
const decode=(file:string)=>JSON.parse(Buffer.from(readFileSync(file,'utf8').split(':').slice(1).join(':'),'base64').toString('utf8'))
function fixture(options:any={}){
 const h=mainHarness(options),{SettingsStore}=h.load('src/main/storage/settingsStore.ts'),store=new SettingsStore()
 const file=(name:string)=>join(h.directory,name)
 const unrelated=['auth-account.json','auth-session.json','online-auth-v1.json','accounts.json','contact-details-v1.sec']
 const preserved=new Map(unrelated.map(name=>[name,encode({fixture:'must remain byte-for-byte unchanged',name})]))
 for(const [name,value] of preserved)writeFileSync(file(name),value)
 function checkPreserved(){for(const [name,value] of preserved)assert.equal(readFileSync(file(name),'utf8'),value,name)}
 function cleanup(){const target=resolve(h.directory);assert.match(target,/hellodog-test-[^\\/]+$/);rmSync(target,{recursive:true,force:true})}
 return {store,file,checkPreserved,cleanup,directory:h.directory}
}

test('Chinese send preference persists false and global changes update all existing windows atomically',async()=>{
 const h=fixture()
 try{
  await h.store.save({...(await h.store.get()),blockChineseSend:false})
  assert.equal((await h.store.runtime()).blockChineseSend,false)
  await h.store.save({...(await h.store.get()),blockChineseSend:true})
  assert.equal((await h.store.runtime()).blockChineseSend,true)
  const local=mainHarness(),{AccountManager}=local.load('src/main/accounts/accountManager.ts'),accounts=new AccountManager()
  try{
   const a=await accounts.add('whatsapp','WA'),b=await accounts.add('telegram','TG'),c=await accounts.add('signal','Signal')
   await accounts.setChineseSendPolicy(false)
   assert.ok((await accounts.list()).every((item:any)=>item.blockChineseSend===false))
   await accounts.update(a.id,{blockChineseSend:true})
   const rows=await accounts.list();assert.equal(rows.find((item:any)=>item.id===a.id).blockChineseSend,true)
   assert.equal(rows.find((item:any)=>item.id===b.id).blockChineseSend,false);assert.equal(rows.find((item:any)=>item.id===c.id).blockChineseSend,false)
  }finally{rmSync(local.directory,{recursive:true,force:true})}
 }finally{h.cleanup()}
})

test('startup removes all retired provider credentials and migrates private services to cloud while preserving user data',async()=>{
 for(const provider of ['openai','deepl','google']){
  const h=fixture()
  try {
   const preferences={provider,openaiApiKey:'fixture-old',openaiModel:'old-model',deeplApiKey:'fixture-deepl',googleApiKey:'fixture-google',targetLanguage:'fr-FR',localLanguage:'zh-CN',quickReplies:['Saved reply'],closeBehaviorVersion:1}
   writeFileSync(h.file('settings.sec'),encode(preferences,'plain'));writeFileSync(h.file('settings-keys.sec'),encode({openaiApiKey:'fixture-old',deeplApiKey:'fixture-deepl',googleApiKey:'fixture-google'}));writeFileSync(h.file('settings-keys.sec.tmp'),encode({openaiApiKey:'incomplete-old-write'}))
   await h.store.migrateLegacySecrets()
   const settings=decode(h.file('settings.sec')),value=await h.store.get()
   for(const key of ['openaiApiKey','openaiModel','deeplApiKey','googleApiKey']){assert.equal(settings[key],undefined);assert.equal(value[key],undefined)}
   assert.equal(value.provider,'openai');assert.equal(value.translationProvider,'deepseek');assert.equal(value.targetLanguage,'fr-FR');assert.deepEqual(Array.from(value.quickReplies),['Saved reply'])
   assert.equal(existsSync(h.file('settings-keys.sec')),false);assert.equal(existsSync(h.file('settings-keys.sec.tmp')),false);h.checkPreserved()
   const before=readFileSync(h.file('settings.sec'),'utf8');await h.store.migrateLegacySecrets();assert.equal(readFileSync(h.file('settings.sec'),'utf8'),before);h.checkPreserved()
  }finally{h.cleanup()}
 }
})

test('environment credentials are ignored and cannot be pulled into the client preference file',async()=>{
 const names=['OPENAI_API_KEY','OPENAI_MODEL','DEEPL_API_KEY','GOOGLE_TRANSLATE_API_KEY'],old=Object.fromEntries(names.map(name=>[name,process.env[name]])),h=fixture()
 try{
  Object.assign(process.env,{OPENAI_API_KEY:'fixture-old',OPENAI_MODEL:'retired-model',DEEPL_API_KEY:'fixture-deepl',GOOGLE_TRANSLATE_API_KEY:'fixture-google'})
  const value=await h.store.get();for(const key of ['openaiApiKey','openaiModel','deeplApiKey','googleApiKey'])assert.equal(value[key],undefined)
  await h.store.migrateLegacySecrets();assert.equal(existsSync(h.file('settings-keys.sec')),false);h.checkPreserved()
 }finally{for(const name of names){if(old[name]===undefined)delete process.env[name];else process.env[name]=old[name]}h.cleanup()}
})

test('stale UI saves cannot restore credentials or personal provider routing; selected new-window default remains',async()=>{
 const h=fixture()
 try{
  for(const credential of ['fixture-another-stale','saved-secret','cloud-managed','']){
   await h.store.save({provider:'google',translationProvider:'openai',openaiApiKey:credential,openaiModel:'old',deeplApiKey:credential,googleApiKey:credential,fontSize:15})
   const value=await h.store.publicSettings();assert.equal(value.provider,'openai');assert.equal(value.translationProvider,'openai');assert.equal(value.fontSize,15)
   for(const key of ['openaiApiKey','openaiModel','deeplApiKey','googleApiKey'])assert.equal(value[key],undefined)
   assert.equal(existsSync(h.file('settings-keys.sec')),false)
  }
  await assert.rejects(h.store.save({provider:'openai',translationProvider:'invalid'}),/通道无效/);h.checkPreserved()
 }finally{h.cleanup()}
})

test('only known retired encrypted fields are removed; unknown fields remain encrypted and undisclosed',async()=>{
 const h=fixture();try{
  writeFileSync(h.file('settings-keys.sec'),encode({openaiApiKey:'fixture-old',deeplApiKey:'fixture-old',otherIntegration:'preserved-future-secret'}))
  await h.store.migrateLegacySecrets();assert.deepEqual(decode(h.file('settings-keys.sec')),{otherIntegration:'preserved-future-secret'});assert.equal((await h.store.publicSettings()).otherIntegration,undefined);h.checkPreserved()
 }finally{h.cleanup()}
})

test('failed system decryption or encryption preserves original settings and login records',async()=>{
 for(const failure of ['decrypt','encrypt']){
  const h=fixture({safeStorage:{isEncryptionAvailable:()=>failure!=='encrypt',encryptString:(value:string)=>Buffer.from(value),decryptString:(value:Buffer)=>{if(failure==='decrypt')throw new Error('fixture decrypt failed');return value.toString()}}})
  try{writeFileSync(h.file('settings.sec'),encode({openaiApiKey:'fixture-retired',deeplApiKey:'fixture-deepl'}));writeFileSync(h.file('settings-keys.sec'),encode({openaiApiKey:'fixture-retired-keys',googleApiKey:'fixture-google'}));const before=new Map(readdirSync(h.directory).map(name=>[name,readFileSync(h.file(name),'utf8')]));await assert.rejects(h.store.migrateLegacySecrets());for(const [name,value] of before)assert.equal(readFileSync(h.file(name),'utf8'),value);assert.deepEqual(readdirSync(h.directory).sort(),Array.from(before.keys()).sort());h.checkPreserved()}finally{h.cleanup()}
 }
})
