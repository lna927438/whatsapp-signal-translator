import {test} from 'node:test'
import assert from 'node:assert/strict'
import {rmSync} from 'node:fs'
import {basename} from 'node:path'
import {mainHarness} from './main-harness.ts'

function cleanup(path:string){assert.match(basename(path),/^hellodog-test-[a-zA-Z0-9]+$/);rmSync(path,{recursive:true,force:true})}

test('voice manifests reject another platform or architecture before native execution',()=>{
 const h=mainHarness();try{
  const {validateNativeVoiceManifest}=h.load('src/main/translation/nativeVoiceManifest.ts')
  const mac={platform:'darwin',arch:'arm64',executable:'whisper-cli',model:'ggml-base.bin',files:{'whisper-cli':'a'.repeat(64),'ggml-base.bin':'b'.repeat(64)}}
  assert.equal(validateNativeVoiceManifest(mac,'darwin','arm64'),mac)
  for(const target of [['win32','x64'],['darwin','x64'],['linux','arm64']])assert.throws(()=>validateNativeVoiceManifest(mac,...target),/不匹配/)
  assert.throws(()=>validateNativeVoiceManifest({...mac,arch:undefined},'darwin','arm64'),/不匹配/)
  assert.throws(()=>validateNativeVoiceManifest({...mac,files:{...mac.files,'../external':'a'.repeat(64)}},'darwin','arm64'),/不匹配/)
  const win={executable:'whisper-cli.exe',model:'ggml-base.bin',files:{'whisper-cli.exe':'c'.repeat(64),'ggml-base.bin':'b'.repeat(64)}}
  assert.equal(validateNativeVoiceManifest(win,'win32','x64'),win)
 }finally{cleanup(h.directory)}
})

test('Mac update paths never read a Windows feed, revive cached Windows offers, download or run EXEs',async()=>{
 let network=0,opened=0
 const h=mainHarness({app:{getPath:()=>h.directory,getVersion:()=> '0.5.23'},shell:{openPath:()=>{opened++;return ''}}},async()=>{network++;throw Error('must not fetch Windows feed')})
 try{
  const {JsonStore}=h.load('src/main/storage/jsonStore.ts')
  await new JsonStore('update-state.json',{},true).write({manifest:{version:'9.0.0',versionKey:'windows/v9.0.0/setup.exe'},phase:'verified',recoveryDirectory:'C:/old-install'})
  const {UpdateManager}=h.load('src/main/updates.ts'),updates=new UpdateManager('darwin')
  const notice=await updates.notice(true),info=await updates.info()
  assert.equal(notice.status,'manual');assert.equal(notice.available,false);assert.equal(notice.verified,false);assert.equal(notice.show,false)
  assert.equal(info.automaticUpdates,false);assert.equal(info.manifest,undefined);assert.equal(info.recoveryDirectory,undefined)
  for(const action of [()=>updates.check('stable'),()=>updates.download(),()=>updates.openInstaller(),()=>updates.openRecovery(),()=>updates.snooze('9.0.0')])await assert.rejects(action,/Mac/)
  assert.equal(network,0);assert.equal(opened,0)
 }finally{cleanup(h.directory)}
})

test('desktop browser identity keeps Mac and Windows headers consistent with the real platform',()=>{
 const h=mainHarness();try{
  const {desktopBrowserIdentity}=h.load('src/main/network/browserIdentity.ts')
  const mac=desktopBrowserIdentity('darwin','150.0.0.0'),win=desktopBrowserIdentity('win32','150.0.0.0')
  assert.match(mac.userAgent,/Macintosh; Intel Mac OS X/);assert.doesNotMatch(mac.userAgent,/Windows/);assert.equal(mac.clientHintPlatform,'"macOS"')
  assert.match(win.userAgent,/Windows NT 10.0; Win64; x64/);assert.equal(win.clientHintPlatform,'"Windows"')
 }finally{cleanup(h.directory)}
})
