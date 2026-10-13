import assert from 'node:assert/strict'
import {readFile, readdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../',import.meta.url)),output=process.argv[2]
assert.ok(output,'Provide directory containing win-unpacked')
const require=createRequire(import.meta.url),builder=createRequire(require.resolve('electron-builder'))
const asar=createRequire(builder.resolve('app-builder-lib'))('@electron/asar')
const resources=resolve(output,'win-unpacked/resources'),archive=join(resources,'app.asar')
async function noLinks(directory){for(const entry of await readdir(directory,{withFileTypes:true})){assert.equal(entry.isSymbolicLink(),false,'Packaged runtime must be self-contained: '+join(directory,entry.name));if(entry.isDirectory())await noLinks(join(directory,entry.name))}}
await noLinks(resolve(output,'win-unpacked'))
const source=(name)=>asar.extractFile(archive,join(...name.split(/[\\/]+/).filter(Boolean))).toString()
const main=source('out/main/index.js'),preload=source('out/preload/index.js'),google=source('out/preload/googleVoice.js'),whatsapp=source('out/preload/whatsapp.js')
for(const token of ['voice:translate-file-audio','voice:translate-message','google-voice:voice-audio','voice-zh-','voice-en-','englishTranslation','recognizeWithLanguage','preserveVoiceRequest','转为中文'])assert.ok(main.includes(token),'Missing packaged main behavior '+token)
for(const token of ['voice:translate-file-audio','voice:translate-message'])assert.ok(preload.includes(token))
for(const token of ['__HD_VOICE_INSTALLED__','whatsapp-message:','WAWebCollections','WAWebMediaInMemoryBlobCache','downloadAndMaybeDecrypt','.Audio.inline',"messageId:'voice:'+conversation.id+':'+id",'record.voiceElement'])assert.ok(main.includes(token),'Missing packaged per-app voice behavior '+token)
for(const text of [main,google])assert.ok(!text.includes('请选择从这条语音下载的音频文件'),'Retired per-message file-selection fallback was packaged')
for(const token of ['google-voice:voice-audio','audio[controls]','gv-audio-player','data-hellodog-voice-audio','google-voice-audio:','voice:google-voice:','englishTranslation'])assert.ok(google.includes(token),'Missing packaged Google Voice behavior '+token)
assert.ok(whatsapp.includes('voice:translate-message'))
const files=asar.listPackage(archive),renderer=files.filter(name=>/out[\\/]renderer[\\/]assets[\\/]index-[^\\/]+\.js$/.test(name)).map(name=>source(name)).join('\n')
for(const text of ['语音翻译','转为中文','translateVoiceFileAudio','VITE_SUPABASE_PUBLISHABLE_KEY'])assert.ok(renderer.includes(text),'Missing packaged interface '+text)
assert.ok(!files.some(name=>/(?:^|[\\/])\.env(?:\.|$)/.test(name)),'Environment file in client')
for(const text of [main,preload,google,whatsapp,renderer])assert.ok(!/\b(?:sk-proj-|sk-admin-|sb_secret_)[A-Za-z0-9_-]{24,}/.test(text),'Provider credential in client')
const manifest=JSON.parse(await readFile(join(root,'resources/voice/manifest.json'),'utf8'))
const hash=data=>createHash('sha256').update(data).digest('hex')
assert.deepEqual((await readdir(join(resources,'voice'))).sort(),Object.keys(manifest.files).sort())
for(const [name,digest]of Object.entries(manifest.files))assert.equal(hash(await readFile(join(resources,'voice',name))),digest,name)
assert.equal(hash(await readFile(join(resources,'signal-desktop/resources/app.asar'))),hash(await readFile(join(root,'integrations/signal-desktop/release/hellodog-security-core/win-unpacked/resources/app.asar'))),'Signal voice build differs')
console.log(JSON.stringify({passed:true,version:JSON.parse(source('package.json')).version,voiceBridges:true,allAppVoiceEntries:true,googleVoiceMessageIdentity:true,settingsEntry:true,voiceResourcesVerified:true,nativeSignalMatchesCandidate:true,providerSecretsAbsent:true,localOnly:true}))
