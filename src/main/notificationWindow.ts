import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { noticeWindowBounds } from '../shared/clientNotices'
import { mainFrame } from './securityPolicy'
export interface ToastData {key:string;category:string;title:string;body:string;level:string;actionLabel:string;closeLabel:string;detailsLabel:string;brand:string;errorLabel:string}
export class NotificationWindow {
  private popup?:BrowserWindow
  private data:ToastData|null=null
  private ready=false
  private timeout?:ReturnType<typeof setTimeout>
  private blocked=false
  private disposed=false
  constructor(private parent:BrowserWindow,private callbacks:{action:(key:string,action:'dismiss'|'open'|'details')=>Promise<void>;displayed:(key:string)=>void;hidden:()=>void}) {
    const owned=(event:Electron.IpcMainInvokeEvent)=>{if(!this.popup||event.sender.id!==this.popup.webContents.id||!mainFrame(event))throw new Error('Invalid notification window')}
    ipcMain.handle('notice-window:state',event=>{owned(event);return this.data})
    ipcMain.handle('notice-window:action',async(event,key:string,action:string)=>{owned(event);if(key!==this.data?.key||!['dismiss','open','details'].includes(action))return;await callbacks.action(key,action as 'dismiss'|'open'|'details')})
    ipcMain.handle('notice-window:painted',(event,key:string)=>{owned(event);if(key===this.data?.key&&this.canShow()&&this.popup?.isVisible()){callbacks.displayed(key);this.arm()}})
    ipcMain.handle('notice-window:hover',(event,hover:boolean)=>{owned(event);if(hover)clearTimeout(this.timeout);else this.arm(5000)})
    const position=()=>this.position(),hide=()=>this.popup?.hide()
    parent.on('move',position);parent.on('resize',position);parent.on('restore',position);parent.on('maximize',position);parent.on('unmaximize',position);parent.on('focus',position);parent.on('show',position)
    parent.on('blur',hide);parent.on('hide',hide);parent.on('minimize',hide)
    parent.on('closed',()=>{this.disposed=true;clearTimeout(this.timeout);this.popup?.destroy();for(const name of ['state','action','painted','hover'])ipcMain.removeHandler('notice-window:'+name)})
  }
  private canShow(){return !this.blocked&&!this.disposed&&!this.parent.isDestroyed()&&this.parent.isVisible()&&!this.parent.isMinimized()&&this.parent.isFocused()}
  private arm(ms=12000){clearTimeout(this.timeout);this.timeout=setTimeout(()=>{this.hide();this.callbacks.hidden()},ms);this.timeout.unref?.()}
  setBlocked(value:boolean){this.blocked=value;this.position()}
  private position(){
    if(!this.popup||this.popup.isDestroyed())return
    if(!this.data||!this.ready||!this.canShow()){this.popup.hide();return}
    this.popup.setBounds(noticeWindowBounds(this.parent.getContentBounds()))
    if(!this.popup.isVisible()){this.popup.showInactive();this.popup.webContents.send('notice-window:changed',this.data)}
  }
  async show(data:ToastData){
    if(this.disposed)return
    this.data=data
    if(!this.popup){
      const popup=this.popup=new BrowserWindow({parent:this.parent,show:false,frame:false,transparent:false,backgroundColor:'#191e24',resizable:false,movable:false,minimizable:false,maximizable:false,fullscreenable:false,focusable:false,skipTaskbar:true,hasShadow:true,roundedCorners:true,
        ...noticeWindowBounds(this.parent.getContentBounds()),webPreferences:{preload:join(__dirname,'../preload/notice.js'),contextIsolation:true,sandbox:true,nodeIntegration:false}})
      popup.setMenu(null);popup.webContents.setWindowOpenHandler(()=>({action:'deny'}));popup.webContents.on('will-navigate',event=>event.preventDefault())
      if(process.env.ELECTRON_RENDERER_URL)await popup.loadURL(new URL('notification.html',process.env.ELECTRON_RENDERER_URL).href)
      else await popup.loadFile(join(__dirname,'../renderer/notification.html'))
      if(this.disposed)return;this.ready=true
    }
    this.popup.webContents.send('notice-window:changed',this.data);this.position()
  }
  hide(){clearTimeout(this.timeout);this.data=null;this.popup?.hide()}
}
