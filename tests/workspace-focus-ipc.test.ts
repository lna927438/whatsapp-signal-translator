import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'
import {createRequire} from 'node:module'
const {WorkspaceFocus}=createRequire(import.meta.url)('../src/main/workspaceFocus.ts') as typeof import('../src/main/workspaceFocus')
const {boundedOperation}=createRequire(import.meta.url)('../src/main/boundedOperation.ts') as typeof import('../src/main/boundedOperation')
const source=readFileSync(new URL('../src/main/ipc.ts',import.meta.url),'utf8')
const deferred=()=>{let resolve!:(value?:any)=>void;const promise=new Promise<any>(yes=>{resolve=yes});return {promise,resolve}}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0))
function fixture(){
 const handlers=new Map<string,Function>(),calls:any[]=[],records=[{id:'wa-a',platform:'whatsapp'},{id:'wa-b',platform:'whatsapp'},{id:'sd',platform:'signal',signalEngine:'desktop'},{id:'cli',platform:'signal',signalEngine:'cli'}]
 let visible='',holdList:Promise<any>|undefined,holdOpen:Promise<any>|undefined,holdRefresh:Promise<any>|undefined
 const context:any={WorkspaceFocus,Promise,Map,identityRevision:0,requireMain:(e:any)=>{if(e.sender!==1)throw Error('main only')},requireAuth:async()=>{},taskIdentity:()=>({authorized:()=>true}),
  boundedOperation:(work:Promise<any>,_ms:number,message:string)=>boundedOperation(work,20,message),
  ipcMain:{handle:(name:string,fn:Function)=>handlers.set(name,fn)},mainWindow:{isDestroyed:()=>false,on:()=>{},webContents:{send:(...args:any[])=>calls.push(['event',...args])}},
  accounts:{list:async()=>{if(holdList){const result=holdList;holdList=undefined;return result}return records}},
  whatsapp:{hideAll:()=>{calls.push(['hide-wa']);if(visible.startsWith('wa'))visible=''},applyPreferences:()=>{calls.push(['preferences']);return new Promise(()=>{})},focus:async(id:string)=>{visible=id;calls.push(['wa-focus',id]);return {state:'loading'}},reload:async(id:string)=>{calls.push(['wa-reload',id]);await holdRefresh}},
  signalDesktop:{focus:(id:string)=>{calls.push(['sd-focus',id]);if(id)visible=id;else if(visible==='sd')visible=''},open:async(record:any,background:boolean)=>{calls.push(['sd-open',record.id,background]);await holdOpen;if(!background)visible=record.id;return {state:'starting'}},status:()=>({state:'stopped'}),reload:async()=>{calls.push(['sd-reload'])}},
  signal:{refreshAccount:async(id:string)=>calls.push(['cli-refresh',id])},googleVoice:{hide:()=>{calls.push(['hide-gv']);if(visible==='gv')visible=''},focus:async()=>{visible='gv';return {state:'ready'}},refresh:async(id:string)=>{calls.push(['gv-refresh',id]);return {state:'loading'}},close:async()=>true,list:async()=>[{id:'gv'}]},shell:{openExternal:async()=>{}}
 }
 const sections=[source.slice(source.indexOf('  const workspaceFocus='),source.indexOf('  const voice =')),source.slice(source.indexOf("  ipcMain.handle('google-voice:focus',"),source.indexOf("  ipcMain.handle('google-voice:back',")),source.slice(source.indexOf("  ipcMain.handle('platform:focus',"),source.indexOf("  ipcMain.handle('ui:set-overlay-open',")),source.slice(source.indexOf('  const refreshes ='),source.indexOf("  ipcMain.handle('accounts:unread-snapshot',"))]
 runInNewContext(ts.transpileModule(sections.join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context)
 return {calls,records,visible:()=>visible,holdList:(value:Promise<any>)=>holdList=value,holdOpen:(value:Promise<any>)=>holdOpen=value,holdRefresh:(value:Promise<any>)=>holdRefresh=value,expire:()=>context.identityRevision++,invoke:(name:string,...args:any[])=>Promise.resolve().then(()=>handlers.get(name)!({sender:1},...args))}
}

test('WhatsApp preferences scripts cannot delay showing the account or switching to Google Voice',async()=>{
 const h=fixture();assert.equal((await h.invoke('platform:focus',{platform:'whatsapp',accountId:'wa-a'})).state,'loading');assert.equal(h.visible(),'wa-a')
 assert.equal((await h.invoke('google-voice:focus','gv')).state,'ready');assert.equal(h.visible(),'gv')
})
test('an older account lookup finishing last cannot focus or hide the latest account',async()=>{
 const h=fixture(),hold=deferred();h.holdList(hold.promise)
 const first=h.invoke('platform:focus',{platform:'whatsapp',accountId:'wa-a'});await tick()
 await h.invoke('platform:focus',{platform:'whatsapp',accountId:'wa-b'});assert.equal((await first).state,'cancelled')
 hold.resolve(h.records);await tick();assert.equal(h.visible(),'wa-b');assert.deepEqual(h.calls.filter(row=>row[0]==='wa-focus'),[['wa-focus','wa-b']])
})
test('a slow Signal launch runs in background and cannot regain visibility after WhatsApp is selected',async()=>{
 const h=fixture(),hold=deferred();h.holdOpen(hold.promise)
 const signal=h.invoke('platform:focus',{platform:'signal',accountId:'sd'});await tick()
 await h.invoke('platform:focus',{platform:'whatsapp',accountId:'wa-a'});assert.equal((await signal).state,'cancelled')
 hold.resolve();await tick();assert.equal(h.visible(),'wa-a');assert.deepEqual(h.calls.find(row=>row[0]==='sd-open'),['sd-open','sd',true])
})
test('stopped Signal refresh stays background and never hides the active WhatsApp window',async()=>{
 const h=fixture();await h.invoke('platform:focus',{platform:'whatsapp',accountId:'wa-a'});h.calls.length=0
 assert.equal(await h.invoke('platform:refresh','sd'),true);assert.equal(h.visible(),'wa-a');assert.equal(h.calls.some(row=>row[0].startsWith('hide')||row[0]==='sd-focus'),false)
 assert.deepEqual(h.calls.find(row=>row[0]==='sd-open'),['sd-open','sd',true])
})
test('Google Voice refresh neither opens an inactive window nor clears other platform views',async()=>{
 const h=fixture();await h.invoke('platform:focus',{platform:'whatsapp',accountId:'wa-a'});h.calls.length=0
 assert.equal((await h.invoke('google-voice:refresh','gv')).state,'cancelled');assert.equal(h.visible(),'wa-a');assert.deepEqual(h.calls,[])
 await h.invoke('app:google-voice');assert.equal((await h.invoke('google-voice:refresh','gv')).state,'loading')
})
test('hung refresh releases the UI with an error and remains independent from platform focus',async()=>{
 const h=fixture(),hold=deferred();h.holdRefresh(hold.promise)
 const refresh=h.invoke('platform:refresh','wa-a'),failure=assert.rejects(refresh,/刷新仍在等待/)
 await h.invoke('platform:focus',{platform:'whatsapp',accountId:'wa-b'});assert.equal(h.visible(),'wa-b');await failure
 hold.resolve();await tick();assert.equal(h.visible(),'wa-b');assert.equal(h.calls.some(row=>row[0]==='event'&&row[2]?.action==='refreshed'),false)
})
test('an identity change while reading the requested account cancels focus before any view action',async()=>{
 const h=fixture(),hold=deferred();h.holdList(hold.promise);const focus=h.invoke('platform:focus',{platform:'whatsapp',accountId:'wa-a'});await tick();h.expire();hold.resolve(h.records)
 assert.equal((await focus).state,'cancelled');assert.equal(h.calls.some(row=>row[0]==='wa-focus'),false)
})
