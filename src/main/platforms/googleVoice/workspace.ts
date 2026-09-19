import { app, screen, type BrowserWindow } from 'electron'
import { join } from 'path'
import { GoogleVoiceOfficialWindow } from './officialWindow'
import { GoogleVoiceRecords, googleVoiceProfileRoot, type GoogleVoiceRecord } from './windowRecords'
import { GoogleVoiceNativeWindowHost, discoverGoogleVoiceWindows } from './nativeWindowHost'

type Identity={owner:string;authorized:()=>boolean}
type Bounds={x:number;y:number;width:number;height:number}
type Instance={owner:string;record:GoogleVoiceRecord;launcher:GoogleVoiceOfficialWindow;host?:GoogleVoiceNativeWindowHost;ready?:boolean}
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))

export class GoogleVoiceWorkspace {
  private instances=new Map<string,Instance>()
  private opening=new Map<string,Promise<unknown>>()
  private active=''
  private revision=0
  private overlay=false
  private bounds:Bounds={x:0,y:0,width:800,height:600}
  private detaching?:Promise<void>
  private lifecycle=0
  private changing=new Set<string>()
  private windowRevisions=new Map<string,number>()
  private closing=false
  constructor(private window:BrowserWindow,readonly records:GoogleVoiceRecords,private identity:()=>Identity) {
    const update=()=>this.applyVisibility()
    window.on('show',update);window.on('hide',update);window.on('minimize',update);window.on('restore',update);window.on('resize',update);window.on('move',update)
    window.on('close',event=>{
      if(event.defaultPrevented || this.closing || !this.instances.size&&!this.opening.size&&!this.detaching)return
      event.preventDefault()
      void this.detachAll().then(()=>{if(window.isDestroyed())return;this.closing=true;try{window.close()}finally{this.closing=false}}).catch(()=>{
        if(!window.isDestroyed())window.webContents.send('translator:error','Google Voice 窗口尚未安全分离，请在官方窗口关闭后再退出 HelloDog。')
      })
    })
  }
  private available(identity:Identity,lifecycle:number,id?:string,version?:number){return !this.window.isDestroyed()&&!this.closing&&!this.detaching&&identity.authorized()&&lifecycle===this.lifecycle&&(!id||!this.changing.has(id)&&(this.windowRevisions.get(id)||0)===version)}
  private requireAvailable(identity:Identity,lifecycle:number){if(!this.available(identity,lifecycle))throw new Error('窗口或登录状态已变化，请稍后重新打开。')}
  private instance(record:GoogleVoiceRecord,identity:Identity){
    let item=this.instances.get(record.id)
    if(item&&item.owner!==identity.owner)throw new Error('旧账号窗口尚未完成分离，请稍后重试。')
    if(!item){item={owner:identity.owner,record,launcher:new GoogleVoiceOfficialWindow(googleVoiceProfileRoot(app.getPath('userData'),identity.owner,record.id),{},record.browser)};this.instances.set(record.id,item)}
    return item
  }
  private invalidate(id:string){this.windowRevisions.set(id,(this.windowRevisions.get(id)||0)+1);if(this.active===id)this.hide()}
  private helper(){return app.isPackaged?join(process.resourcesPath,'native/GoogleVoiceWindowHost.exe'):join(app.getAppPath(),'resources/native/GoogleVoiceWindowHost.exe')}
  private safe(record:GoogleVoiceRecord){return {id:record.id,label:record.label,tabOrder:record.tabOrder,browser:record.browser}}
  async list(){const identity=this.identity();const rows=await this.records.list(identity.owner);if(!identity.authorized())throw new Error('登录状态已变化。');return rows.map(row=>this.safe(row))}
  async add(){const identity=this.identity();const row=await this.records.add(identity.owner);if(!identity.authorized())throw new Error('登录状态已变化。');return this.safe(row)}
  async update(id:string,patch:{label?:string}){const identity=this.identity();if(!patch || typeof patch.label!=='string')throw new Error('名称无效。');const row=await this.records.update(identity.owner,id,{label:patch.label});if(!identity.authorized())throw new Error('登录状态已变化。');return this.safe(row)}
  async reorder(ids:string[]){const identity=this.identity();const rows=await this.records.reorder(identity.owner,ids);if(!identity.authorized())throw new Error('登录状态已变化。');return rows.map(row=>this.safe(row))}
  hide(){this.revision++;this.active='';this.applyVisibility()}
  setOverlayOpen(open:boolean){this.overlay=open;this.applyVisibility()}
  setBounds(value:Bounds){if(!value || !['x','y','width','height'].every(key=>Number.isFinite(value[key as keyof Bounds])) || value.width<1 || value.height<1 || value.width>20000 || value.height>20000)return;this.bounds={x:Math.max(0,value.x),y:Math.max(0,value.y),width:value.width,height:value.height};this.applyVisibility()}
  private applyVisibility(){
    if(this.window.isDestroyed())return
    const scale=screen.getDisplayMatching(this.window.getBounds()).scaleFactor*this.window.webContents.getZoomFactor()
    const b=this.bounds,clamp=(value:number)=>Math.max(0,Math.min(64000,Math.round(value*scale))),physical={x:clamp(b.x),y:clamp(b.y),width:Math.max(1,clamp(b.width)),height:Math.max(1,clamp(b.height))}
    for(const [id,item] of this.instances){
      if(!item.host)continue
      let current=false;try{current=this.identity().owner===item.owner}catch{}
      const visible=item.ready===true && current && id===this.active && !this.overlay && this.window.isVisible() && !this.window.isMinimized()
      item.host.setBounds(physical);item.host.setVisible(visible)
    }
  }
  async focus(id?:string){
    const identity=this.identity(),revision=++this.revision,lifecycle=this.lifecycle,version=this.windowRevisions.get(id||'')||0
    if(!this.available(identity,lifecycle,id,version))return {state:'cancelled'}
    this.active=id || '';this.applyVisibility()
    if(!id)return {state:'empty'}
    const record=await this.records.get(identity.owner,id)
    if(!this.available(identity,lifecycle,id,version) || revision!==this.revision)return {state:'cancelled'}
    let work=this.opening.get(id)
    if(!work){work=this.open(record,identity,lifecycle,version);this.opening.set(id,work);void work.then(()=>{if(this.opening.get(id)===work)this.opening.delete(id)},()=>{if(this.opening.get(id)===work)this.opening.delete(id)})}
    try{await work}catch(error){if(!this.available(identity,lifecycle,id,version)||revision!==this.revision)return {state:'cancelled'};throw error}
    if(!this.available(identity,lifecycle,id,version) || revision!==this.revision){this.applyVisibility();return {state:'cancelled'}}
    this.active=id;this.applyVisibility();this.instances.get(id)?.host?.focus();return {state:'ready'}
  }
  private async open(record:GoogleVoiceRecord,identity:Identity,lifecycle:number,version:number){
    const authorized=()=>this.available(identity,lifecycle,record.id,version)
    const requireCurrent=()=>{if(!authorized())throw new Error('窗口或登录状态已变化，官方窗口已保留。')}
    requireCurrent()
    const instance=this.instance(record,identity)
    if(instance.host){if(instance.ready)return;throw new Error('Google Voice 窗口恢复尚未确认，请稍后重试。')}
    let detail=await instance.launcher.resolveDetails();requireCurrent()
    let windows:Awaited<ReturnType<typeof discoverGoogleVoiceWindows>>=[]
    if(detail){windows=await discoverGoogleVoiceWindows(this.helper(),detail.executable,detail.profile);requireCurrent()}
    if(!windows.length){await instance.launcher.open(authorized);detail=instance.launcher.details();requireCurrent()}
    if(!detail)throw new Error('无法确认 Google Voice 浏览器。')
    if(!record.browser){await this.records.update(identity.owner,record.id,{browser:detail.browser});requireCurrent()}
    for(let attempt=0;attempt<12;attempt++){
      if(windows.length)break
      requireCurrent()
      windows=await discoverGoogleVoiceWindows(this.helper(),detail.executable,detail.profile)
      requireCurrent()
      if(windows.length)break
      await pause(500)
    }
    if(windows.length!==1)throw new Error('暂时无法唯一识别 Google Voice 窗口。请先保留一个官方主窗口，再重新接入。')
    const host=new GoogleVoiceNativeWindowHost(this.helper())
    const native=this.window.getNativeWindowHandle(),parentHwnd=(native.length===8?native.readBigUInt64LE():BigInt(native.readUInt32LE())).toString()
    // Register before attach: a failed attachment can still require confirmed
    // recovery. Never lose that handle while deciding whether the parent can close.
    instance.host=host;instance.ready=false
    const owned=instance
    host.onDisconnected(error=>{
      if(owned.host!==host)return
      owned.ready=false
      if(!error)owned.host=undefined
      if(error && !this.window.isDestroyed())this.window.webContents.send('translator:error',error.message)
    })
    try{
      await host.attach({parentHwnd,parentPid:process.pid,child:windows[0],executable:detail.executable,profile:detail.profile},authorized)
      requireCurrent()
      instance.ready=true
    }catch(error){
      await host.detach()
      if(instance.host===host)instance.host=undefined
      throw error
    }
    this.applyVisibility()
  }
  async external(id:string){return this.withExternal(id,false)}
  async extensionSetup(id:string){return this.withExternal(id,true)}
  private async withExternal(id:string,extensions:boolean){
    const identity=this.identity(),lifecycle=this.lifecycle,record=await this.records.get(identity.owner,id)
    this.requireAvailable(identity,lifecycle)
    if(this.changing.has(id))throw new Error('此窗口正在调整，请稍后重试。')
    this.changing.add(id);this.invalidate(id)
    try{
      await this.opening.get(id)?.catch(()=>undefined);this.requireAvailable(identity,lifecycle)
      const instance=this.instance(record,identity)
      const hosted=!!instance.host
      if(instance.host){await instance.host.detach();instance.host=undefined}
      this.requireAvailable(identity,lifecycle)
      let detail=await instance.launcher.resolveDetails();this.requireAvailable(identity,lifecycle)
      const existing=detail?await discoverGoogleVoiceWindows(this.helper(),detail.executable,detail.profile):[]
      this.requireAvailable(identity,lifecycle)
      if(!hosted&&!existing.length){await instance.launcher.open(()=>this.available(identity,lifecycle));detail=instance.launcher.details();this.requireAvailable(identity,lifecycle)}
      if(detail&&!record.browser){await this.records.update(identity.owner,id,{browser:detail.browser});this.requireAvailable(identity,lifecycle)}
      if(extensions){await instance.launcher.openExtensions(()=>this.available(identity,lifecycle));this.requireAvailable(identity,lifecycle)}
      return {state:'external'}
    }finally{this.changing.delete(id)}
  }
  async close(id:string){
    const identity=this.identity(),lifecycle=this.lifecycle;await this.records.get(identity.owner,id)
    this.requireAvailable(identity,lifecycle)
    if(this.changing.has(id))throw new Error('此窗口正在调整，请稍后重试。')
    this.changing.add(id);this.invalidate(id)
    try{
      await this.opening.get(id)?.catch(()=>undefined);this.requireAvailable(identity,lifecycle)
      const instance=this.instances.get(id)
      if(instance?.owner!==identity.owner&&instance)throw new Error('登录状态已变化。')
      if(instance?.host)await instance.host.detach()
      this.requireAvailable(identity,lifecycle);this.instances.delete(id)
      await this.records.update(identity.owner,id,{closed:true});this.requireAvailable(identity,lifecycle);return true
    }finally{this.changing.delete(id)}
  }
  async refresh(id:string){
    await this.records.get(this.identity().owner,id)
    // Actual reload must be requested by the installed extension. Blindly
    // synthesizing F5 into another application could reload the wrong window.
    return this.focus(id)
  }
  detachAll():Promise<void>{
    if(this.detaching)return this.detaching
    this.lifecycle++
    this.hide()
    const work=(async()=>{
      await Promise.allSettled([...this.opening.values()])
      for(const [id,item] of this.instances){if(item.host)await item.host.detach();this.instances.delete(id)}
    })()
    this.detaching=work;void work.then(()=>{this.detaching=undefined},()=>{this.detaching=undefined});return work
  }
}
