import {spawn} from 'node:child_process'
import {createWriteStream,mkdirSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
const root=fileURLToPath(new URL('../../',import.meta.url)),mode=process.argv.includes('--inspect-public')?'--inspect-public':'--self-test'
const evidence=join(root,'verification/google-voice-embedded-research-20260920');mkdirSync(evidence,{recursive:true})
const environment={...process.env,TEMP:'D:/UserAppData/Temp',TMP:'D:/UserAppData/Temp'};delete environment.ELECTRON_RUN_AS_NODE
const stream=createWriteStream(join(evidence,mode==='--self-test'?'prototype-fixture.log':'prototype-public.log'))
const child=spawn(join(root,'node_modules/electron/dist/electron.exe'),[fileURLToPath(new URL('main.cjs',import.meta.url)),mode],{cwd:root,env:environment,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']})
child.stdout.pipe(stream,{end:false});child.stderr.pipe(stream,{end:false})
const timer=setTimeout(()=>{child.kill();},60000)
const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code))})
clearTimeout(timer);stream.end();console.log(JSON.stringify({mode,exitCode:code}));process.exitCode=code??1
