import { app, BrowserWindow, screen, ipcMain } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, realpathSync } from 'fs'
import { mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { createHash, randomUUID } from 'crypto'
import type { AccountRecord } from '../../types'
import { setAccountState, setExternalMetrics } from '../../runtimeHealth'
import { updateAccountUnread, notifyAccount } from '../../desktopRuntime'

export type DesktopTranslationRequest = { id: string; editTimestamp?: number; conversationId: string; text: string; direction: 'incoming' | 'outgoing' | 'display'; group?: boolean; sentAt?: number; manual?: boolean; expiresAt?: number; authorizationOnly?: boolean; requestId?: string; translated?: string }
type Instance = { owner: string; accountId: string; child: ChildProcess; helper?: ChildProcess; state: 'starting' | 'ready' | 'failed' | 'stopped'; error?: string; version?: string; startedAt: number; visible?: boolean; boundsKey?: string; pending?: number; view?: string; startupTimer?: ReturnType<typeof setTimeout>; refresh?: { id:string; work:Promise<void>; finish:(error?:boolean)=>void } }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export function signalDesktopProfile(root: string, owner: string, accountId: string): string {
  if (!owner || !accountId) throw new Error('Signal 账号不可用。')
  return join(root, 'signal-desktop-profiles', digest(owner).slice(0,32), digest(accountId).slice(0,32))
}

/** A separate upstream Electron process and database per HelloDog account.
 * IPC is an inherited private process handle; no localhost server or open port. */
export class SignalDesktopHost {
  private instances = new Map<string,Instance>()
  private opening = new Map<string,Promise<ReturnType<SignalDesktopHost['status']>>>()
  private closing = new Map<string,Promise<void>>()
  private restartPreparations = new Map<string, { id: string; work: Promise<void>; finish: (error?: boolean) => void }>()
  private draftInsertions = new Map<string, { id: string; finish: (error?: boolean) => void }>()
  private active = ''
  private overlay = false
  private bounds = {x:0,y:0,width:800,height:600}
  constructor(private window: BrowserWindow, private owner: () => string,
    private translate: (accountId:string, request:DesktopTranslationRequest, startedAt:number) => Promise<unknown>,
    private contentLifecycle?: (owner:string, accountId:string, updates:Array<{id:string;conversationId:string;expiresAt:number}>)=>Promise<void>) {
    window.on('hide',()=>this.updateVisibility())
    window.on('show',()=>this.updateVisibility())
    window.on('resize',()=>this.updateVisibility())
    window.on('move',()=>this.updateVisibility())
    const activateHost = (event: Electron.IpcMainEvent) => {
      if(event.sender!==window.webContents)return
      const item=this.instances.get(this.active)
      if(item?.visible)item.helper?.stdin?.write('focus-host\n')
    }
    ipcMain.on('signal-desktop:activate-host',activateHost)
    window.once('closed',()=>ipcMain.removeListener('signal-desktop:activate-host',activateHost))
    // before-quit may be cancelled by the user's pending-task prompt.
    app.on('will-quit',event=>{
      if(!this.instances.size&&!this.closing.size)return
      event.preventDefault()
      void this.stopAll().then(()=>app.quit())
    })
  }
  private paths() {
    const root = app.isPackaged ? join(process.resourcesPath,'signal-desktop') : join(app.getAppPath(),'integrations/signal-desktop')
    const packaged = join(root,'Signal.exe')
    const index = join(root,'node_modules/electron/index.js')
    const electronRoot = existsSync(index) ? dirname(realpathSync(index)) : join(root,'node_modules/electron')
    return { executable: existsSync(packaged) ? packaged : join(electronRoot,'dist/electron.exe'), args: existsSync(packaged) ? [] : [root],
      helper: app.isPackaged ? join(process.resourcesPath,'native/SignalWindowHost.exe') : join(app.getAppPath(),'resources/native/SignalWindowHost.exe'), root }
  }
  status(accountId:string) {
    const paths=this.paths(), item=this.instances.get(accountId)
    return { available:existsSync(paths.executable)&&existsSync(paths.helper)&&(paths.args.length===0||existsSync(join(paths.root,'bundles/main.js'))), state:item?.state||'stopped',error:item?.error||'',version:item?.version||'8.27.0',view:item?.view||'',pending:item?.pending||0 }
  }
  async open(record: AccountRecord, background=false) {
    const pending=this.opening.get(record.id)
    if(pending)return pending
    const opening=this.start(record,background)
    this.opening.set(record.id,opening)
    try{return await opening}finally{if(this.opening.get(record.id)===opening)this.opening.delete(record.id)}
  }
  private async start(record:AccountRecord, background:boolean) {
    const owner=this.owner(), previous=this.instances.get(record.id)
    if(previous&&previous.owner===owner&&['starting','ready'].includes(previous.state)) {if(!background)this.focus(record.id);return this.status(record.id)}
    if(record.runtimeMode==='paused') throw new Error('请先恢复此账号。')
    const paths=this.paths()
    if(!this.status(record.id).available) throw new Error('官方 Signal 桌面组件尚未编译完成。')
    if(previous) await this.stop(record.id)
    await this.closing.get(record.id)
    const profile=signalDesktopProfile(app.getPath('userData'),owner,record.id)
    await mkdir(profile,{recursive:true})
    if(owner!==this.owner()) throw new Error('登录状态已变化。')
    const env: NodeJS.ProcessEnv={...process.env, NODE_ENV:'production',HELLODOG_EMBEDDED:'1',HELLODOG_SIGNAL_USER_DATA:profile}
    delete env.ELECTRON_RUN_AS_NODE
    const child=spawn(paths.executable,paths.args,{cwd:paths.root,env,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']})
    const item:Instance={owner,accountId:record.id,child,state:'starting',startedAt:Date.now()}
    this.instances.set(record.id,item);if(!background)this.active=record.id
    const current=()=>this.instances.get(record.id)===item&&owner===this.owner()
    const publish=()=>{if(!this.window.isDestroyed())this.window.webContents.send('signal-desktop:status',{accountId:record.id,...this.status(record.id)})}
    const reply=(value:any)=>{if(current()&&child.connected)child.send({channel:'hellodog',...value})}
    item.startupTimer=setTimeout(()=>{if(current()&&item.state==='starting'){item.state='failed';item.error='Signal 启动超时，数据已保留，请重新打开。';publish()}},90000)
    item.startupTimer.unref()
    child.on('message',(raw:any)=>{
      if(!current()||raw?.channel!=='hellodog')return
      if(raw.type==='unread'&&Number.isSafeInteger(raw.count)&&raw.count>=0&&raw.count<=99999){updateAccountUnread(record.id,raw.count);this.window.webContents.send('accounts:unread',{accountId:record.id,count:raw.count})}
      if(raw.type==='notification')notifyAccount(record.id,record.note||record.label,{silent:raw.silent===true?true:undefined})
      if(raw.type==='privacy' && this.contentLifecycle && Array.isArray(raw.updates) && raw.updates.length <= 100 && raw.updates.every((value:any)=>value && /^[\w-]{1,100}$/.test(value.id) && /^[\w-]{1,100}$/.test(value.conversationId) && Number.isSafeInteger(value.expiresAt) && value.expiresAt >= 0)) {
        void this.contentLifecycle(owner, record.id, raw.updates).then(()=>reply({type:'privacy-applied',updates:raw.updates}),()=>{
          item.error='本机译文清理未完成，正在保留原清理记录以便重试。';publish()
        })
      }
      if(raw.type==='refreshed'&&raw.id===item.refresh?.id)item.refresh?.finish(Boolean(raw.error))
      if(raw.type==='health'&&raw.metrics)setExternalMetrics(record.id,raw.metrics)
      if(raw.type==='restart-ready'&&raw.id===this.restartPreparations.get(record.id)?.id)this.restartPreparations.get(record.id)?.finish(Boolean(raw.error))
      if(raw.type==='draft-inserted'&&raw.id===this.draftInsertions.get(record.id)?.id)this.draftInsertions.get(record.id)?.finish(Boolean(raw.error))
      if(raw.type==='request-refresh')void this.reload(record).catch(()=>this.window.webContents.send('translator:error','刷新未完成，草稿已保留。'))
      if(raw.type==='activate'&&this.active===record.id&&!this.overlay&&item.visible) item.helper?.stdin?.write('focus\n')
      if(raw.type==='connection'&&['receiving','connecting','disconnected'].includes(raw.state)) setAccountState(record.id,raw.state)
      if(raw.type==='health'&&['Blank','Installer','Inbox','Standalone'].includes(raw.view)) {item.view=raw.view;item.pending=Number.isInteger(raw.pending)?Math.min(100000,Math.max(0,raw.pending)):0;publish()}
      if(raw.type==='ready'&&/^\d{1,20}$/.test(String(raw.handle))&&raw.pid===child.pid&&!item.helper){
        item.version=String(raw.version)
        const parent=this.window.getNativeWindowHandle().readBigUInt64LE().toString()
        const helper=spawn(paths.helper,[parent,raw.handle,String(process.pid),String(child.pid)],{windowsHide:true,stdio:['pipe','pipe','pipe']})
        item.helper=helper
        helper.stdout?.on('data',chunk=>{if(String(chunk).includes('attached')&&current()){clearTimeout(item.startupTimer);item.state='ready';this.updateVisibility();publish()}})
        helper.stdin?.on('error',()=>{})
        helper.on('error',()=>{item.state='failed';item.error='Signal 窗口接入失败。';publish()})
        helper.on('exit',code=>{if(item.state==='ready'&&code){item.state='failed';item.error='Signal 窗口已断开，请重新打开。';publish()}})
      }
      if(raw.type==='translate'&&typeof raw.id==='string'){
        const request=raw.request as DesktopTranslationRequest
        if (request?.authorizationOnly !== undefined && (request.authorizationOnly !== true || request.direction !== 'outgoing' || !/^send-[\w-]{1,150}$/.test(request.requestId || '') || typeof request.translated !== 'string' || request.translated.length > 20000)) { reply({type:'translation',id:raw.id,error:'发送记录无效。'}); return }
        if(request?.editTimestamp!==undefined&&(!Number.isSafeInteger(request.editTimestamp)||request.editTimestamp<=0)){reply({type:'translation',id:raw.id,error:'翻译内容无效。'});return}
        if(!request||typeof request.text!=='string'||request.text.length>10000||!['incoming','outgoing','display'].includes(request.direction)||! /^[\w-]{1,100}$/.test(request.id)||! /^[\w-]{1,100}$/.test(request.conversationId)||(request.expiresAt!==undefined&&(!Number.isSafeInteger(request.expiresAt)||request.expiresAt<0))){reply({type:'translation',id:raw.id,error:'翻译内容无效。'});return}
        void this.translate(record.id,request,item.startedAt).then(result=>reply({type:'translation',id:raw.id,result}),error=>{
          // Only known user-facing messages cross the process boundary. Do not
          // leak raw provider responses, stack traces, tokens or message text.
          const known = ['可用字符已用完，无法发送翻译消息。请补充字符后重试，草稿已保留。','译文仍含中文，已阻止发送并保留草稿。','仍含中文原文，已阻止发送。请开启发送翻译后重试。','暂时无法恢复在线登录，请检查网络或重新登录。草稿已保留。','在线登录尚未恢复，请重新登录。草稿已保留。','原发送记录尚未核实，消息未发送。请在原消息上重试。','本机译文已按保留期清理，不会自动重新翻译。','此消息已删除或过期，不能再次翻译。','译文语言与目标不符，消息未发送。请修改译文或检查目标语言。','在线登录状态已过期，请重新登录后核对原请求。','可用字符余额不足。原请求已保留，结算以查询结果为准。','本次翻译未成功，云端已确认未扣费。']
          reply({type:'translation',id:raw.id,error:known.includes(error?.message)?error.message:'翻译暂未完成，消息未发送。原请求已保留，可重试原消息。'})
        })
      }
      if(raw.type==='conversation'&&typeof raw.context?.id==='string'&& /^[\w-]{1,100}$/.test(raw.context.id)){
        this.window.webContents.send('signal-desktop:conversation',{accountId:record.id,id:'signal-desktop:'+raw.context.id,name:String(raw.context.name||'Signal').slice(0,150)})
      }
    })
    child.on('error',()=>{clearTimeout(item.startupTimer);item.state='failed';item.error='无法启动 Signal 桌面组件。';publish()})
    child.on('exit',code=>{clearTimeout(item.startupTimer);item.refresh?.finish(true);item.helper?.stdin?.end('quit\n');item.helper=undefined;if(item.state!=='stopped'){item.state=code?'failed':'stopped';item.error=code?'Signal 已退出，聊天数据保留，可重新打开。':'';setAccountState(record.id,'closed')}publish()})
    publish();return this.status(record.id)
  }
  focus(accountId='') {this.active=accountId;this.updateVisibility();const item=this.instances.get(accountId);if(item?.visible)item.helper?.stdin?.write('focus\n');if(item?.child.connected)item.child.send({channel:'hellodog',type:'focus'})}
  setOverlayOpen(value:boolean){this.overlay=value;this.updateVisibility()}
  setBounds(value:any){if(!value||!['x','y','width','height'].every(key=>Number.isFinite(value[key])))return;this.bounds={x:Math.max(0,value.x),y:Math.max(0,value.y),width:Math.max(1,Math.min(16000,value.width)),height:Math.max(1,Math.min(16000,value.height))};this.updateVisibility()}
  refresh(accountId?:string){for(const item of this.instances.values())if((!accountId||item.accountId===accountId)&&item.owner===this.owner()&&item.child.connected)item.child.send({channel:'hellodog',type:'refresh'})}
  async reload(record:AccountRecord):Promise<void>{
    if(record.runtimeMode==='paused')throw new Error('请先恢复此账号。')
    const item=this.instances.get(record.id)
    if(!item||item.owner!==this.owner()||!['ready','starting'].includes(item.state)){await this.open(record);return}
    if(item.refresh)return item.refresh.work
    if(item.state!=='ready'||!item.child.connected)throw new Error('Signal 正在打开，请稍后刷新。')
    const id=randomUUID()
    let finish:(error?:boolean)=>void=()=>{}
    const work=new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>finish(true),20000)
      finish=(error=false)=>{clearTimeout(timer);if(item.refresh?.id===id)item.refresh=undefined;error?reject(new Error('刷新未完成，聊天和草稿已保留。')):resolve()}
    })
    item.refresh={id,work,finish}
    item.child.send({channel:'hellodog',type:'reload',id},error=>{if(error)finish(true)})
    return work
  }
  private updateVisibility(){
    if(this.window.isDestroyed())return
    const factor=screen.getDisplayMatching(this.window.getBounds()).scaleFactor*this.window.webContents.getZoomFactor()
    const values=[this.bounds.x,this.bounds.y,this.bounds.width,this.bounds.height].map(value=>Math.round(value*factor))
    for(const [id,item] of this.instances){
      if(!item.helper?.stdin?.writable)continue
      const boundsKey=values.join(' ')
      if(item.boundsKey!==boundsKey){item.boundsKey=boundsKey;item.helper.stdin.write('bounds '+boundsKey+'\n')}
      const visible=id===this.active&&!this.overlay&&this.window.isVisible()
      if(item.visible!==visible){item.visible=visible;item.helper.stdin.write(visible?'show\n':'hide\n');if(item.child.connected)item.child.send({channel:'hellodog',type:'visibility',visible})}
    }
  }
  pendingCount(){return [...this.instances.values()].reduce((sum,item)=>sum+(item.pending||0),0)}
  async insertDraft(accountId:string,text:string):Promise<void>{
    const item=this.instances.get(accountId)
    if(!item || item.owner!==this.owner() || item.state!=='ready' || !item.child.connected || this.active!==accountId) throw new Error('请先打开目标 Signal 对话。')
    if(this.draftInsertions.has(accountId))throw new Error('快捷回复正在填入，请稍候。')
    const id=randomUUID()
    return new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>finish(true),8000)
      const finish=(error=false)=>{
        clearTimeout(timer);this.draftInsertions.delete(accountId)
        if(error)reject(new Error('请打开目标对话并保留或清空已有草稿。快捷回复尚未确认填入，请先查看输入框。'))
        else resolve()
      }
      this.draftInsertions.set(accountId,{id,finish})
      item.child.send({channel:'hellodog',type:'insert-draft',id,text},error=>{if(error)finish(true)})
    })
  }
  async prepareRestart(): Promise<void> {
    for (const item of this.instances.values()) {
      if (!item.child.connected || item.state === 'stopped') continue
      const prior = this.restartPreparations.get(item.accountId)
      if (prior) { await prior.work; continue }
      const id = randomUUID()
      let finish: (error?: boolean) => void = () => {}
      const work = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(true), 12000)
        finish = (error = false) => {
          clearTimeout(timer); this.restartPreparations.delete(item.accountId)
          if (error) reject(new Error('Signal 尚未准备好重启。请先结束通话或录音，等待附件保存后重试。'))
          else resolve()
        }
      })
      this.restartPreparations.set(item.accountId, { id, work, finish })
      item.child.send({channel:'hellodog',type:'prepare-restart',id}, error => { if (error) finish(true) })
      await work
    }
  }
  async resume(records:AccountRecord[]){for(const record of records){if(record.platform==='signal'&&record.signalEngine==='desktop'&&record.runtimeMode!=='paused')await this.open(record,true)}}
  async stop(accountId:string):Promise<void>{
    setExternalMetrics(accountId)
    this.draftInsertions.get(accountId)?.finish(true)
    const item=this.instances.get(accountId)
    if(!item)return this.closing.get(accountId)
    item.state='stopped';clearTimeout(item.startupTimer);item.refresh?.finish(true);this.instances.delete(accountId)
    const stopped=new Promise<void>(resolve=>{
      const finish=()=>{clearTimeout(timer);item.helper?.stdin?.end('quit\n');resolve()}
      const timer=setTimeout(()=>{item.child.kill();finish()},15000)
      if(item.child.exitCode!==null||!item.child.pid){finish();return}
      item.child.once('exit',finish)
      if(item.child.connected)item.child.send({channel:'hellodog',type:'quit'})
      else item.child.kill()
    })
    this.closing.set(accountId,stopped)
    try{await stopped}finally{if(this.closing.get(accountId)===stopped)this.closing.delete(accountId)}
  }
  async stopAll(){const stopped=[...this.instances.keys()].map(id=>this.stop(id));this.active='';await Promise.all([...stopped,...this.closing.values()])}
}
