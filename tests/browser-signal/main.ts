import {app,BrowserWindow,ipcMain,dialog,nativeImage,Menu,clipboard,ClipboardItem,session} from 'electron'
import {join,resolve} from 'node:path'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {registerSignalFeatures} from '../../src/main/platforms/signal/signalFeatures'
import {registerSignalMediaScheme,installSignalMediaProtocol} from '../../src/main/platforms/signal/signalMediaProtocol'
import {signalPreferenceDefaults} from '../../src/shared/signalPreferences'

const root=process.env.HELLODOG_QA_REPO!, directory=process.env.HELLODOG_QA_DIRECTORY!
if(!root||!directory||!resolve(directory).startsWith(resolve(root,'verification')+'\\'))throw new Error('An isolated verification directory is required')
app.setPath('userData',join(directory,'profile'));app.setPath('sessionData',join(directory,'profile'))
app.setPath('logs',join(directory,'logs'));app.setName('HelloDog isolated verification')
registerSignalMediaScheme();app.disableHardwareAcceleration()
const account='+12025550100',peer='+12025550123',now=Date.now()
const fixture:any={owner:'fixture-owner',mode:'manual',autoAttempts:0,manualCalls:[],saveCalls:[],menuItems:[],network:[],copiedHash:'',restored:false}
;(globalThis as any).signalQa=fixture
async function start() {
await app.whenReady()
await mkdir(join(directory,'profile'),{recursive:true});await mkdir(join(directory,'downloads'),{recursive:true})
app.setPath('downloads',join(directory,'downloads'))
await writeFile(join(directory,'profile','accounts.json'),JSON.stringify([{id:'fixture-signal',platform:'signal',signalAccount:account,label:'Signal test'}]))
const imagePaths:Record<string,string>={}
for(const [index,id] of ['photo-one','photo-two','photo-three'].entries()){
 const width=480,height=320,pixels=Buffer.alloc(width*height*4)
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const p=(y*width+x)*4;pixels[p]=60+index*45;pixels[p+1]=Math.round(70+y/3);pixels[p+2]=Math.round(80+x/5);pixels[p+3]=255}
 const path=join(directory,id+'.png');await writeFile(path,nativeImage.createFromBitmap(pixels,{width,height}).toPNG());imagePaths[id]=path
}
imagePaths.document=join(directory,'document.pdf');await writeFile(imagePaths.document,'%PDF-1.4\nfixture-only\n')
const attachment=(id:string)=>({id,filename:id.startsWith('photo')?'附件':'document.pdf',contentType:id.startsWith('photo')?'image/png':'application/pdf',size:500})
let messages:any[]=[{account,peer,timestamp:now-30000,fromMe:false,original:'',attachments:[attachment('photo-one'),attachment('photo-two'),attachment('photo-three')]},{account,peer,timestamp:now-20000,fromMe:false,original:'https://example.com/trip',attachments:[attachment('document')]},{account,peer,timestamp:now-10000,fromMe:false,original:'A lovely afternoon 😊',attachments:[]},{account,peer,timestamp:now-5000,fromMe:false,original:'See you tomorrow!',attachments:[]}]
const contact={id:peer,aliases:[peer],name:'Demo contact',kind:'contact',number:peer}
const signal:any={loadHistory:async()=>messages.filter(m=>!m.expired),listContacts:async()=>[contact],media:{received:async(_owner:string,_account:string,item:any)=>{fixture.lastMediaId=item.id;return imagePaths[item.id]}},preferences:{get:async()=>structuredClone(signalPreferenceDefaults)},markRead:async()=>structuredClone(signalPreferenceDefaults),request:async(_account:string,method:string)=>{if(method==='getAvatar')return{};if(method==='listContacts')return[contact];throw new Error('No live Signal calls are permitted in this fixture')}}
session.defaultSession.webRequest.onBeforeRequest((details,callback)=>{if(/^https?:/.test(details.url)){fixture.network.push(details.url);callback({cancel:true})}else callback({})})
installSignalMediaProtocol()
const window=new BrowserWindow({show:false,width:1360,height:900,webPreferences:{preload:join(root,'out/preload/index.js'),sandbox:true,contextIsolation:true,nodeIntegration:false}})
fixture.window=window;fixture.images=imagePaths;fixture.messages=messages
dialog.showSaveDialog=async(_w:any,options:any)=>{fixture.saveCalls.push(options);fixture.savedSource=imagePaths[fixture.lastMediaId];return{canceled:false,filePath:join(directory,'downloads','saved-photo.png')}}
const buildMenu=Menu.buildFromTemplate.bind(Menu)
Menu.buildFromTemplate=((items:any[])=>{const menu=buildMenu(items);menu.popup=((_options:any)=>{fixture.menuItems=items.map(item=>item.label);items[0].click();_options.callback?.()}) as any;return menu}) as any
// Preserve every existing clipboard format in memory, without logging contents.
let clipboardBefore:Electron.ClipboardItem[]|undefined
fixture.prepareClipboard=async()=>{
 clipboardBefore=[]
 for(const item of await clipboard.read()){const data:any={};for(const type of item.types)data[type]=await item.getType(type);clipboardBefore.push(new ClipboardItem(data))}
}
fixture.checkClipboard=async()=>{
 for(const item of await clipboard.read())if(item.types.includes('image/png')){const blob=await item.getType('image/png');fixture.copiedHash=createHash('sha256').update(nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer())).toBitmap()).digest('hex');return fixture.copiedHash}
 return ''
}
fixture.savedPixelHash=()=>createHash('sha256').update(nativeImage.createFromPath(join(directory,'downloads','saved-photo.png')).toBitmap()).digest('hex')
fixture.restoreClipboard=async()=>{
 if(!clipboardBefore)return
 const expected=fixture.copiedHash,current=await fixture.checkClipboard()
 if(expected&&current===expected){await clipboard.write(clipboardBefore);fixture.restored=true}
 clipboardBefore=undefined
}
registerSignalFeatures(window,signal,()=>fixture.owner)
const handlers:any={'platform:focus':true,'draft:get':'','draft:save':true,'signal:runtime-status':{state:'ready',message:'Ready'},'signal:list-accounts':[account],'signal:list-contacts':[contact],'signal-desktop:status':{available:false},'signal:typing-snapshot':[],'send:pending':null,'settings:get':{previewSend:false},'signal:staged-media':[]}
for(const [channel,value] of Object.entries(handlers))ipcMain.handle(channel,()=>value)
ipcMain.handle('signal:history',()=>messages)
ipcMain.handle('signal:translate-message',(_event,id,identity)=>{fixture.manualCalls.push({id,identity});return identity.timestamp===now-10000?'美好的下午 😊':'明天见！'})
ipcMain.handle('signal:display-message',(_event,_id,identity)=>{if(fixture.mode!=='auto'||identity.timestamp!==now-5000)return;fixture.autoAttempts++;if(fixture.autoAttempts===1)throw new Error('Fixture transient network failure');return '明天见！'})
await window.loadFile(join(directory,'renderer','index.html'))
app.on('window-all-closed',()=>app.quit())
}
void start().catch(error=>{console.error(error);app.exit(1)})
