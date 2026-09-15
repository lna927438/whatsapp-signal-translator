import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs'
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

test('startup removes retired key and model from legacy preferences and encrypted keys without changing other services or login data',async()=>{
 const h=fixture()
 try{
  const preferences={provider:'openai',openaiApiKey:'fixture-retired-inline',openaiModel:'retired-model',deeplApiKey:'fixture-deepl-inline',googleApiKey:'fixture-google-inline',targetLanguage:'fr-FR',localLanguage:'zh-CN',quickReplies:['Saved reply'],closeBehaviorVersion:1}
  writeFileSync(h.file('settings.sec'),encode(preferences,'plain'));writeFileSync(h.file('settings-keys.sec'),encode({openaiApiKey:'fixture-retired-encrypted',deeplApiKey:'fixture-deepl',googleApiKey:'fixture-google'}))
  await h.store.migrateLegacySecrets()
  const settings=decode(h.file('settings.sec')),keys=decode(h.file('settings-keys.sec')),value=await h.store.get()
  assert.equal(settings.openaiApiKey,undefined);assert.equal(settings.openaiModel,undefined);assert.equal(keys.openaiApiKey,undefined)
  assert.deepEqual(keys,{deeplApiKey:'fixture-deepl',googleApiKey:'fixture-google'});assert.equal(value.openaiApiKey,undefined);assert.equal(value.openaiModel,undefined)
  assert.equal(value.provider,'openai','cloud transport legacy identifier stays compatible');assert.equal(value.targetLanguage,'fr-FR');assert.deepEqual(Array.from(value.quickReplies),['Saved reply'])
  assert.equal(settings.deeplApiKey,undefined);assert.equal(settings.googleApiKey,undefined);h.checkPreserved()
  const before=readFileSync(h.file('settings.sec'),'utf8'),beforeKeys=readFileSync(h.file('settings-keys.sec'),'utf8');await h.store.migrateLegacySecrets();assert.equal(readFileSync(h.file('settings.sec'),'utf8'),before);assert.equal(readFileSync(h.file('settings-keys.sec'),'utf8'),beforeKeys);h.checkPreserved()
 }finally{h.cleanup()}
})

test('OpenAI environment credentials and model are ignored, while DeepL and Google environment credentials remain usable',async()=>{
 const names=['OPENAI_API_KEY','OPENAI_MODEL','DEEPL_API_KEY','GOOGLE_TRANSLATE_API_KEY'],old=Object.fromEntries(names.map(name=>[name,process.env[name]])),h=fixture()
 try{
  Object.assign(process.env,{OPENAI_API_KEY:'fixture-retired-env',OPENAI_MODEL:'retired-env-model',DEEPL_API_KEY:'fixture-deepl-env',GOOGLE_TRANSLATE_API_KEY:'fixture-google-env'})
  const value=await h.store.get();assert.equal(value.openaiApiKey,undefined);assert.equal(value.openaiModel,undefined);assert.equal(value.deeplApiKey,'fixture-deepl-env');assert.equal(value.googleApiKey,'fixture-google-env')
  await h.store.migrateLegacySecrets();assert.deepEqual(decode(h.file('settings-keys.sec')),{deeplApiKey:'fixture-deepl-env',googleApiKey:'fixture-google-env'});h.checkPreserved()
 }finally{for(const name of names){if(old[name]===undefined)delete process.env[name];else process.env[name]=old[name]}h.cleanup()}
})

test('stale UI saves cannot restore retired credentials, and saved-secret placeholders preserve unrelated keys',async()=>{
 const h=fixture()
 try{
  await h.store.save({provider:'openai',deeplApiKey:'fixture-deepl',googleApiKey:'fixture-google',openaiApiKey:'fixture-stale-raw',openaiModel:'stale-model'})
  for(const credential of ['fixture-another-stale','saved-secret','cloud-managed','']){
   const publicValue=await h.store.publicSettings();assert.equal(publicValue.openaiApiKey,undefined);assert.equal(publicValue.openaiModel,undefined);assert.equal(publicValue.deeplApiKey,'saved-secret');assert.equal(publicValue.googleApiKey,'saved-secret')
   await h.store.save({...publicValue,openaiApiKey:credential,openaiModel:'stale-model',fontSize:15})
   assert.deepEqual(decode(h.file('settings-keys.sec')),{deeplApiKey:'fixture-deepl',googleApiKey:'fixture-google'});const settings=decode(h.file('settings.sec'));assert.equal(settings.openaiApiKey,undefined);assert.equal(settings.openaiModel,undefined);assert.equal(settings.fontSize,15)
  }
  await h.store.save({...await h.store.publicSettings(),deeplApiKey:'fixture-deepl-new',googleApiKey:''});assert.deepEqual(decode(h.file('settings-keys.sec')),{deeplApiKey:'fixture-deepl-new'});h.checkPreserved()
 }finally{h.cleanup()}
})

test('startup also cleans an encrypted-only retired key file when preferences do not exist',async()=>{
 const h=fixture();try{writeFileSync(h.file('settings-keys.sec'),encode({openaiApiKey:'fixture-retired-only',deeplApiKey:'fixture-preserve'}));await h.store.migrateLegacySecrets();assert.deepEqual(decode(h.file('settings-keys.sec')),{deeplApiKey:'fixture-preserve'});assert.equal((await h.store.publicSettings()).openaiApiKey,undefined);h.checkPreserved()}finally{h.cleanup()}
})

test('failed system decryption or encryption preserves original settings, unrelated keys and login records',async()=>{
 for(const failure of ['decrypt','encrypt']){
  const h=fixture({safeStorage:{isEncryptionAvailable:()=>failure!=='encrypt',encryptString:(value:string)=>Buffer.from(value),decryptString:(value:Buffer)=>{if(failure==='decrypt')throw new Error('fixture decrypt failed');return value.toString()}}})
  try{writeFileSync(h.file('settings.sec'),encode({openaiApiKey:'fixture-retired',deeplApiKey:'fixture-deepl'}));writeFileSync(h.file('settings-keys.sec'),encode({openaiApiKey:'fixture-retired-keys',googleApiKey:'fixture-google'}));const before=new Map(readdirSync(h.directory).map(name=>[name,readFileSync(h.file(name),'utf8')]));await assert.rejects(h.store.migrateLegacySecrets());for(const [name,value] of before)assert.equal(readFileSync(h.file(name),'utf8'),value);assert.deepEqual(readdirSync(h.directory).sort(),Array.from(before.keys()).sort());h.checkPreserved()}finally{h.cleanup()}
 }
})
