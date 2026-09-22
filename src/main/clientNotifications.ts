import { BrowserWindow, ipcMain, shell } from 'electron'
import { clientNotices, noticeKey, noticeActionUrl, type ClientNotice } from '../shared/clientNotices'
import { NoticeJournal } from './storage/noticeJournal'
import { NotificationWindow } from './notificationWindow'
import type { UpdateManager, UpdateNotice } from './updates'
import { t } from './uiLocale'
import { mainFrame } from './securityPolicy'

export class ClientNotifications {
  private user=''
  private revision=0
  private notices:ClientNotice[]=[]
  private update:UpdateNotice|null=null
  private syncedAt=0
  private error=''
  private current:{key:string;notice?:ClientNotice;version?:string}|null=null
  private shown=new Set<string>()
  private work?:Promise<void>
  private receiptWork?:Promise<void>
  private nextAttempt=0
  private recent:number[]=[]
  private disposed=false
  private popup:NotificationWindow
  private journal=new NoticeJournal()
  private timer:ReturnType<typeof setInterval>
  private expiryTimer?:ReturnType<typeof setTimeout>
  constructor(private window:BrowserWindow,private updates:UpdateManager,private identity:()=>string,
    private read:()=>Promise<unknown>,private receipt:(value:{id:string;revision:number;state:string})=>Promise<unknown>) {
    this.popup=new NotificationWindow(window,{action:(key,action)=>this.action(key,action),displayed:key=>this.displayed(key),hidden:()=>{this.current=null;this.showNextLater()}})
    const main=(event:Electron.IpcMainInvokeEvent)=>{if(event.sender.id!==window.webContents.id||!mainFrame(event)||!this.identity()||this.identity()!==this.user)throw new Error('请先登录在线账号。')}
    ipcMain.handle('notices:snapshot',event=>{main(event);return this.snapshot()})
    ipcMain.handle('notices:refresh',async event=>{main(event);await this.refresh(true);return this.snapshot()})
    ipcMain.handle('notices:action',async(event,key:string,action:string)=>{main(event);if(!['dismiss','open'].includes(action))throw new Error('通知操作无效。');await this.action(key,action as 'dismiss'|'open');return this.snapshot()})
    this.timer=setInterval(()=>{void this.refresh()},30000);this.timer.unref?.()
    window.on('focus',()=>{void this.refresh();this.showNext()})
    window.on('closed',()=>{this.disposed=true;clearInterval(this.timer);clearTimeout(this.expiryTimer);for(const name of ['snapshot','refresh','action'])ipcMain.removeHandler('notices:'+name)})
  }
  setOverlayOpen(value:boolean){this.popup.setBlocked(value)}
  setIdentity(){
    const owner=this.identity()
    if(owner!==this.user){this.revision++;this.user=owner;this.notices=[];this.update=null;this.syncedAt=0;this.error='';this.nextAttempt=0;this.shown.clear();this.recent=[];this.current=null;clearTimeout(this.expiryTimer);this.popup.hide();this.popup.setBlocked(false);this.emit()}
    if(owner)void this.refresh()
  }
  private updateAvailable(){return this.update?.verified===true&&this.update.status==='available'&&this.update.available}
  private visibleNotices(){return this.update?.verified===true&&!this.error?this.notices.filter(n=>n.releaseVersion===this.update!.latestVersion&&Date.parse(n.starts_at)<=Date.now()&&(!n.ends_at||Date.parse(n.ends_at)>Date.now())):[]}
  snapshot(){const notices=this.visibleNotices();return {notices,update:this.update,syncedAt:this.syncedAt,error:this.error,unread:notices.filter(n=>!n.dismissed).length+(this.updateAvailable()&&this.update?.show?1:0)}}
  private pruneCurrent(){
    if(this.current&&(this.current.notice?!this.visibleNotices().some(n=>noticeKey(n)===this.current?.key):!this.updateAvailable()||this.current.version!==this.update?.latestVersion)){
      this.current=null;this.popup.hide()
    }
  }
  private scheduleExpiry(){
    clearTimeout(this.expiryTimer)
    const times=this.visibleNotices().filter(n=>n.ends_at).map(n=>Date.parse(n.ends_at!))
    if(!times.length)return
    this.expiryTimer=setTimeout(()=>{if(this.disposed)return;this.pruneCurrent();this.emit();this.showNext();this.scheduleExpiry()},Math.max(1,Math.min(2147483647,Math.min(...times)-Date.now()+1)))
    this.expiryTimer.unref?.()
  }
  private emit(){if(!this.disposed&&!this.window.isDestroyed())this.window.webContents.send('notices:changed',this.snapshot())}
  refresh(force=false):Promise<void>{
    if(this.disposed||!this.user||(!force&&Date.now()<this.nextAttempt))return Promise.resolve()
    if(this.work)return this.work
    const owner=this.user,revision=this.revision
    this.nextAttempt=Date.now()+25000
    this.work=(async()=>{
      const [remote,update]=await Promise.allSettled([this.read(),this.updates.notice(force)])
      if(this.disposed||revision!==this.revision||owner!==this.identity())return
      if(update.status==='fulfilled')this.update=update.value
      else if(this.update)this.update={...this.update,status:'unknown',verified:false,available:false,show:false,notes:undefined,latestVersion:undefined}
      if(remote.status==='fulfilled'){
        try{
          const list=clientNotices(remote.value),local=await this.journal.entries(owner)
          if(revision!==this.revision||owner!==this.identity())return
          this.notices=list.map(n=>({...n,displayed:n.displayed||!!local[noticeKey(n)]?.displayed,dismissed:n.dismissed||!!local[noticeKey(n)]?.dismissed}))
          this.syncedAt=Date.now();this.error=''
        }catch{this.notices=[];this.error=t('通知同步未完成，稍后自动重试。')}
      }else{this.error=t('通知同步未完成，稍后自动重试。');this.nextAttempt=Date.now()+60000}
      this.pruneCurrent();this.scheduleExpiry();this.emit();this.showNext();void this.flushReceipts()
    })().catch(()=>{this.nextAttempt=Date.now()+60000}).finally(()=>{this.work=undefined;if(this.user&&owner!==this.user)void this.refresh()})
    return this.work
  }
  private showNextLater(){const timer=setTimeout(()=>this.showNext(),8000);timer.unref?.()}
  private showNext(){
    if(this.disposed||!this.user||this.user!==this.identity()||this.current)return
    this.recent=this.recent.filter(at=>Date.now()-at<300000);if(this.recent.length>=3)return
    const notice=this.visibleNotices().filter(n=>n.popup&&!n.displayed&&!n.dismissed&&!this.shown.has(noticeKey(n)))
      .sort((a,b)=>Number(b.level==='critical')-Number(a.level==='critical')||Date.parse(b.starts_at)-Date.parse(a.starts_at))[0]
    if(notice&&!this.error)this.current={key:noticeKey(notice),notice}
    else if(this.updateAvailable()&&this.update?.show&&!this.shown.has('update:'+this.update.latestVersion))this.current={key:'update:'+this.update.latestVersion,version:this.update.latestVersion}
    if(!this.current)return
    const current=this.current,n=current.notice
    void this.popup.show({key:current.key,brand:'HelloDog',category:n?t('消息通知'):t('版本更新提醒'),title:n?n.title:t('发现新版本 {0}',current.version),
      body:n?n.body:(this.update?.notes||t('新版本已准备好，可前往官网下载更新。')),level:n?.level||'info',actionLabel:n?(n.action==='website'?t('前往官网'):n.action==='download'&&this.updateAvailable()?t('前往官网更新'):''):t('前往官网更新'),closeLabel:t('知道了'),detailsLabel:t('查看消息中心'),errorLabel:t('暂时无法完成，请稍后重试。')})
      .catch(()=>{if(this.current===current){this.current=null;this.popup.hide()}})
  }
  private displayed(key:string){
    const current=this.current,owner=this.user,revision=this.revision
    if(!current||current.key!==key||this.shown.has(key)||owner!==this.identity()||current.notice&&!this.visibleNotices().some(n=>noticeKey(n)===key)||current.version&&!this.updateAvailable())return
    this.shown.add(key);this.recent.push(Date.now())
    if(current.notice){current.notice.displayed=true;void this.journal.record(owner,current.notice,'displayed').then(()=>this.flushReceipts()).catch(()=>{})}
    else if(current.version)void this.updates.snooze(current.version).then(value=>{if(revision===this.revision&&owner===this.identity()&&this.update?.latestVersion===current.version){this.update=value;this.emit()}}).catch(()=>{})
    this.emit()
  }
  private flushReceipts():Promise<void>{
    if(this.receiptWork||!this.user)return this.receiptWork||Promise.resolve()
    const owner=this.user,revision=this.revision
    this.receiptWork=(async()=>{
      for(const value of await this.journal.pending(owner)){
        if(this.disposed||revision!==this.revision||owner!==this.identity())return
        await this.receipt(value)
        await this.journal.acknowledged(owner,value,value.state)
      }
    })().catch(()=>{}).finally(()=>{this.receiptWork=undefined})
    return this.receiptWork
  }
  private async action(key:string,action:'dismiss'|'open'|'details'){
    const owner=this.user,revision=this.revision;if(!owner||owner!==this.identity())return
    const notice=this.visibleNotices().find(n=>noticeKey(n)===key)
    const version=key==='update:'+this.update?.latestVersion&&this.updateAvailable()?this.update!.latestVersion:null
    if(!notice&&!version)return
    if(action==='details'){
      this.popup.hide();this.current=null;this.window.webContents.send('ui:open-notices');return
    }
    if(action==='open'){
      if(notice?.action==='download'&&!this.updateAvailable())return
      const url=notice?noticeActionUrl(notice.action):'https://hellodog.net/download';if(!url)return
      await shell.openExternal(url)
    }
    if(revision!==this.revision||owner!==this.identity())return
    if(notice){await this.journal.record(owner,notice,'dismissed');if(revision!==this.revision||owner!==this.identity())return;this.notices=this.notices.map(item=>noticeKey(item)===key?{...item,dismissed:true}:item);void this.flushReceipts()}
    else if(version){const value=await this.updates.snooze(version);if(revision!==this.revision||owner!==this.identity())return;this.update=value}
    if(revision!==this.revision)return
    this.shown.add(key);if(this.current?.key===key){this.current=null;this.popup.hide();this.showNextLater()}this.emit()
  }
}
