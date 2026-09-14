import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
const require=createRequire(import.meta.url)
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
function native(directory:string) {
  const handlers=new Map<string,Function>(),sent:any[]=[]
  const ipc={handle:(name:string,fn:Function)=>handlers.set(name,fn),removeHandler:(name:string)=>handlers.delete(name)}
  const process=Object.assign(new EventEmitter(),{env:{HELLODOG_EMBEDDED:'1'},connected:true,send:(value:any)=>sent.push(value)})
  const window=Object.assign(new EventEmitter(),{webContents:{id:7}}),exports:any={}
  const source=readFileSync(new URL('../integrations/hellodog-source/hellodog.privacy.main.ts',import.meta.url),'utf8')
  runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
    exports,process,setInterval,clearInterval,require:(name:string)=>name==='electron'?{app:{getPath:()=>directory},ipcMain:ipc}:require(name),
  })
  exports.attachHelloDogPrivacy(window)
  return{handlers,sent,process,close:()=>window.emit('closed'),record:(updates:any[],sender=7)=>handlers.get('hellodog:content-lifecycle')!({sender:{id:sender}},updates)}
}

test('native deletion notices persist without chat text, replay across restart and resist stale acknowledgements',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'hellodog-privacy-')),path=join(directory,'hellodog-content-outbox-v1.json')
  let h=native(directory)
  try{
    const future={id:'message-a',conversationId:'peer-a',expiresAt:Date.now()+60000},removed={...future,expiresAt:0}
    await h.record([{...future,text:'must never persist'}]);assert.ok(!readFileSync(path,'utf8').includes('must never persist'))
    await h.record([removed]);h.process.emit('message',{channel:'hellodog',type:'privacy-applied',updates:[future]})
    await h.record([]);assert.equal(JSON.parse(readFileSync(path,'utf8'))[0].expiresAt,0)
    h.close();h=native(directory)
    for(let i=0;i<30&&!h.sent.length;i++)await sleep(10)
    assert.equal(h.sent[0].updates[0].expiresAt,0)
    h.process.emit('message',{channel:'hellodog',type:'privacy-applied',updates:[removed]});await h.record([])
    assert.equal(JSON.parse(readFileSync(path,'utf8')).length,0)
    await assert.rejects(h.record([future],99),/Invalid/)
    await assert.rejects(h.record([{...future,id:'../invalid'}]),/Invalid/)
  }finally{h.close();rmSync(directory,{recursive:true,force:true})}
})

test('a corrupt native deletion outbox fails closed instead of overwriting lost cleanup evidence',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'hellodog-privacy-corrupt-')),path=join(directory,'hellodog-content-outbox-v1.json')
  writeFileSync(path,'broken journal');const h=native(directory)
  try{await assert.rejects(h.record([{id:'message',conversationId:'peer',expiresAt:0}]),/清理记录无法读取/);assert.equal(readFileSync(path,'utf8'),'broken journal')}
  finally{h.close();rmSync(directory,{recursive:true,force:true})}
})

test('native lifecycle records timer start and deletion, omits bodies, coalesces repeated saves and never extends a deadline',async()=>{
  const sent:any[]=[],exports:any={}
  const source=readFileSync(new URL('../integrations/hellodog-source/hellodog.privacy.preload.ts',import.meta.url),'utf8')
  runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
    exports,process:{env:{HELLODOG_EMBEDDED:'1',HELLODOG_BRIDGE_ACTIVE:'1'}},setTimeout,clearTimeout,
    require:()=>({ipcRenderer:{invoke:async(name:string,updates:any[])=>sent.push({name,updates})}}),
  })
  const record=exports.recordHelloDogContent,message={id:'message',conversationId:'peer',expireTimer:30,expirationStartTimestamp:10000,body:'private'}
  await record([message]);await record([message]);await record([{...message,expireTimer:60}]);assert.equal(sent.length,1)
  assert.equal(sent[0].updates[0].expiresAt,40000);assert.equal(sent[0].updates[0].body,undefined)
  await record([message],true);assert.equal(sent[1].updates[0].expiresAt,0)
  await record([message]);assert.equal(sent.length,2)
})
