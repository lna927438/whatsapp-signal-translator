import {BrowserWindow} from 'electron'
import {randomBytes} from 'crypto'
export function captchaCallback(value:string,nonce:string):string|null{
 try{const url=new URL(value);if(url.origin!=='https://hellodog.net'||url.pathname!=='/security-check'||url.username||url.password)return null
 const hash=new URLSearchParams(url.hash.slice(1)),token=hash.get('token');return hash.get('nonce')===nonce&&token&&token.length<=4096?token:null}catch{return null}
}
const pending=new Set<number>()
export async function requestAuthChallenge(parent:BrowserWindow):Promise<string>{
 if(pending.has(parent.id))throw new Error('请先完成当前安全验证。')
 pending.add(parent.id)
 const nonce=randomBytes(16).toString('hex'),win=new BrowserWindow({parent,modal:true,width:520,height:540,show:false,autoHideMenuBar:true,title:'HelloDog · 安全验证',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,partition:'captcha-'+nonce}})
 win.setMenu(null);win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));win.webContents.session.setPermissionCheckHandler(()=>false)
 try{return await new Promise<string>((resolve,reject)=>{
   let ended=false
   const finish=(error?:Error,token?:string)=>{if(ended)return;ended=true;clearTimeout(timer);error?reject(error):resolve(token!)}
   const timer=setTimeout(()=>finish(new Error('安全验证超时，请重试。')),120000)
   win.on('closed',()=>finish(new Error('已取消安全验证。')))
   win.webContents.on('will-navigate',(event,url)=>{const token=captchaCallback(url,nonce);if(token){event.preventDefault();finish(undefined,token);return}try{const target=new URL(url);if(target.origin!=='https://hellodog.net'||target.pathname!=='/security-check')event.preventDefault()}catch{event.preventDefault()}})
   win.webContents.on('will-redirect',(event,url)=>{try{const target=new URL(url);if(target.origin!=='https://hellodog.net'||target.pathname!=='/security-check'){event.preventDefault();finish(new Error('安全验证地址无效。'))}}catch{event.preventDefault()}})
   win.webContents.on('did-navigate-in-page',(_event,url,isMain)=>{const token=isMain?captchaCallback(url,nonce):null;if(token)finish(undefined,token)})
   win.once('ready-to-show',()=>win.show())
   void win.loadURL('https://hellodog.net/security-check#nonce='+nonce).catch(()=>finish(new Error('安全验证暂时无法连接，请重试。')))
 })}finally{pending.delete(parent.id);if(!win.isDestroyed())win.destroy()}
}
