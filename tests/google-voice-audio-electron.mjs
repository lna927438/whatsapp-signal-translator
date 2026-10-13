import {createRequire} from 'node:module'
import {mkdir,writeFile,readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'
const root=new URL('../',import.meta.url),require=createRequire(new URL('../website/package.json',import.meta.url)),{build}=createRequire(require.resolve('wrangler'))('esbuild')
const output=new URL('../verification/voice-direct-20261013/google-voice-electron/',import.meta.url);await mkdir(output,{recursive:true})
const bundle=await build({stdin:{resolveDir:fileURLToPath(root),contents:`import './src/preload/googleVoice';import {webFrame} from 'electron';const execute=webFrame.executeJavaScript.bind(webFrame);webFrame.executeJavaScript=(...args)=>execute(...args).catch(error=>{globalThis.__voiceFixtureBridgeError=String(error.stack||error);throw error});globalThis.__voiceFixtureRoots=[];const attach=Element.prototype.attachShadow;Element.prototype.attachShadow=function(options){const root=attach.call(this,options);globalThis.__voiceFixtureRoots.push(root);return root};`,loader:'ts'},bundle:true,write:false,platform:'node',format:'cjs',target:'es2022',external:['electron']})
await writeFile(new URL('preload.cjs',output),bundle.outputFiles[0].text)
const env={...process.env,TEMP:'D:/UserAppData/Temp',TMP:'D:/UserAppData/Temp'};delete env.ELECTRON_RUN_AS_NODE
const child=spawn(fileURLToPath(new URL('../node_modules/electron/dist/electron.exe',import.meta.url)),[fileURLToPath(new URL('google-voice-audio-electron.cjs',import.meta.url)),fileURLToPath(output)],{env,stdio:'pipe',windowsHide:true})
let log='';child.stdout.on('data',value=>log+=value);child.stderr.on('data',value=>log+=value)
const timeout=setTimeout(()=>child.kill(),45000),code=await new Promise(resolve=>child.on('exit',resolve));clearTimeout(timeout);await writeFile(new URL('electron-run.log',output),log)
console.log(await readFile(new URL('electron-audio-results.json',output),'utf8'));if(code!==0)process.exitCode=1
