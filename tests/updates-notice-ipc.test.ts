import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'
test('notice refresh IPC accepts only booleans and forwards explicit force through the owner check',()=>{
 const source=readFileSync(new URL('../src/main/reliabilityIpc.ts',import.meta.url),'utf8'),line=source.split('\n').find(value=>value.includes("ipcMain.handle('updates:notice'"))!,calls:boolean[]=[];let handler!:Function
 runInNewContext(ts.transpileModule(line,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{ipcMain:{handle:(_name:string,fn:Function)=>handler=fn},main:(event:number)=>{if(event!==1)throw Error('owner only')},updates:{notice:(force:boolean)=>calls.push(force)}})
 handler(1);handler(1,true);assert.deepEqual(calls,[false,true]);assert.throws(()=>handler(2,true),/owner only/)
 for(const value of [null,1,'true',{}])assert.throws(()=>handler(1,value),/版本刷新参数无效/)
 assert.deepEqual(calls,[false,true])
})
test('preload forwards manual notice refresh and defaults old callers to cached reads',()=>{
 const source=readFileSync(new URL('../src/preload/index.ts',import.meta.url),'utf8'),line=source.split('\n').find(value=>value.includes('  updateNotice:'))!,calls:any[]=[]
 const api=runInNewContext(ts.transpileModule('('+`{${line}}`+')',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{ipcRenderer:{invoke:(...args:any[])=>calls.push(args)}})
 api.updateNotice();api.updateNotice(true);assert.deepEqual(calls,[['updates:notice',false],['updates:notice',true]])
})
