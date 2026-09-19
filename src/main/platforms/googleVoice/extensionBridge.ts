import { randomBytes, createHash } from 'crypto'
import { createServer, type Server, type Socket } from 'net'
import { mkdir, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

export const extensionId = 'kigfaejcipjibnmnpinplphfldjahknn'
export type BridgePair = { tokenHash:string; owner:string; windowId:string; createdAt:number }
export type BridgeData = { pairs:BridgePair[] }
type Identity = { owner:string; authorized:()=>boolean }
type Storage = { read():Promise<BridgeData>; write(data:BridgeData):Promise<void> }
type Request = { v:1; id:string; op:'pair'|'status'|'translate'|'authorize'|'dispatch-status'|'dispatch-resolve'; pairToken?:string; payload?:unknown }
const digest = (text:string) => createHash('sha256').update(text).digest('hex')
const maximum = 262144

/** Narrow capability bridge: browser code never receives an API/session key. */
export class GoogleVoiceExtensionBridge {
  private codes = new Map<string,{owner:string;windowId:string;until:number;authorized:()=>boolean}>()
  private writes:Promise<unknown> = Promise.resolve()
  constructor(private storage:Storage, private identity:()=>Identity,
    private owns:(owner:string,id:string)=>Promise<boolean>,
    private handle:(owner:string,windowId:string,operation:string,payload:unknown,authorized:()=>boolean)=>Promise<unknown>) {}
  async code(windowId:string):Promise<string> {
    const identity = this.identity()
    if(!identity.authorized() || !await this.owns(identity.owner,windowId) || !identity.authorized()) throw new Error('请重新选择 Google Voice 窗口。')
    for(const [key,row] of this.codes) if(row.until<Date.now() || row.owner===identity.owner && row.windowId===windowId) this.codes.delete(key)
    const code=randomBytes(32).toString('hex')
    this.codes.set(digest(code),{owner:identity.owner,windowId,until:Date.now()+300000,authorized:identity.authorized})
    return code
  }
  async request(input:unknown):Promise<unknown> {
    const raw=input as Request
    const id=typeof raw?.id==='string' && /^[\w-]{1,100}$/.test(raw.id) ? raw.id : ''
    const failure=(code:string,message:string)=>({v:1,id,ok:false,error:{code,message}})
    if(!id || raw.v!==1 || !['pair','status','translate','authorize','dispatch-status','dispatch-resolve'].includes(raw.op)) return failure('invalid','连接请求无效。')
    try {
      const identity=this.identity()
      if(!identity.authorized()) return failure('login','请先登录 HelloDog。')
      let result:unknown
      if(raw.op==='pair') {
        const code=(raw.payload as {code?:unknown})?.code
        if(typeof code!=='string' || !/^[a-f0-9]{64}$/.test(code)) return failure('pair','配对码无效或已过期。')
        const key=digest(code), row=this.codes.get(key)
        // Consume before awaiting: concurrent replays cannot create two pairs.
        this.codes.delete(key)
        if(!row || row.until<Date.now() || row.owner!==identity.owner || !row.authorized() || !await this.owns(row.owner,row.windowId)) return failure('pair','配对码无效或已过期。')
        const token=randomBytes(32).toString('hex')
        const work=this.writes.catch(()=>undefined).then(async()=>{
          const data=await this.storage.read()
          if(!identity.authorized() || !row.authorized()) throw new Error('身份已变化。')
          data.pairs=data.pairs.filter(pair=>pair.owner!==row.owner || pair.windowId!==row.windowId)
          data.pairs.push({tokenHash:digest(token),owner:row.owner,windowId:row.windowId,createdAt:Date.now()})
          await this.storage.write(data)
        })
        this.writes=work; await work
        if(!identity.authorized() || !row.authorized()) return failure('login','请先登录 HelloDog。')
        result={pairToken:token}
      } else {
        if(typeof raw.pairToken!=='string' || !/^[a-f0-9]{64}$/.test(raw.pairToken)) return failure('pair','请先在此窗口配对 HelloDog。')
        await this.writes.catch(()=>undefined)
        const hash=digest(raw.pairToken),row=(await this.storage.read()).pairs.find(pair=>pair.tokenHash===hash && pair.owner===identity.owner)
        if(!row || !identity.authorized() || !await this.owns(row.owner,row.windowId)) return failure('pair','此窗口的配对已失效，请重新配对。')
        result=await this.handle(row.owner,row.windowId,raw.op,raw.payload,identity.authorized)
        if(!identity.authorized() || !await this.owns(row.owner,row.windowId)) return failure('login','登录状态已变化。')
      }
      return {v:1,id,ok:true,result}
    } catch {
      // Do not expose message bodies, cloud errors, credentials, or local paths.
      return failure('unavailable','翻译或连接暂未完成，请检查 HelloDog 的登录、网络和字符余额后重试。原文未自动发送。')
    }
  }
}

export class GoogleVoicePipeServer {
  private server?:Server
  private sockets=new Set<Socket>()
  readonly pipeName='hellodog-google-voice-'+randomBytes(24).toString('hex')
  constructor(private bridge:GoogleVoiceExtensionBridge) {}
  async start() {
    if(this.server)return
    const server=createServer(socket=>{
      if(this.sockets.size>=40){socket.destroy();return}
      this.sockets.add(socket);socket.on('close',()=>this.sockets.delete(socket));socket.on('error',()=>{})
      socket.setTimeout(120000,()=>socket.destroy())
      let buffer=Buffer.alloc(0),working=false
      socket.on('data',chunk=>{
        if(buffer.length+chunk.length>maximum+4){socket.destroy();return}
        buffer=Buffer.concat([buffer,chunk])
        if(working || buffer.length<4)return
        const size=buffer.readUInt32LE(0)
        if(size<1 || size>maximum){socket.destroy();return}
        if(buffer.length<size+4)return
        if(buffer.length!==size+4){socket.destroy();return}
        let request:unknown
        try{request=JSON.parse(buffer.subarray(4).toString('utf8'))}catch{socket.destroy();return}
        buffer=Buffer.alloc(0);working=true
        const timer=setTimeout(()=>socket.destroy(),75000)
        void this.bridge.request(request).then(result=>{
          if(socket.destroyed)return
          const body=Buffer.from(JSON.stringify(result)),header=Buffer.alloc(4)
          if(body.length>maximum){socket.destroy();return}
          header.writeUInt32LE(body.length);socket.write(Buffer.concat([header,body]))
        }).finally(()=>{clearTimeout(timer);working=false;if(buffer.length)socket.destroy()})
      })
    })
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen('\\\\.\\pipe\\'+this.pipeName,()=>{server.off('error',reject);resolve()})})
    this.server=server
  }
  async stop(){for(const socket of this.sockets)socket.destroy();await new Promise<void>(resolve=>this.server?this.server.close(()=>resolve()):resolve());this.server=undefined}
  async register(root:string,executable:string) {
    if(process.platform!=='win32' || !existsSync(executable))throw new Error('Google Voice 连接组件尚未安装。')
    await this.start()
    const directory=join(root,'google-voice-extension');await mkdir(directory,{recursive:true})
    const manifest=join(directory,'net.hellodog.google_voice.json')
    await writeFile(manifest,JSON.stringify({name:'net.hellodog.google_voice',description:'HelloDog Google Voice translation',path:executable,type:'stdio',allowed_origins:[`chrome-extension://${extensionId}/`]},null,2),'utf8')
    const run=promisify(execFile),reg=join(process.env.SystemRoot || 'C:\\Windows','System32','reg.exe')
    const options={windowsHide:true,timeout:10000}
    await run(reg,['add','HKCU\\Software\\HelloDog\\GoogleVoice','/v','PipeName','/t','REG_SZ','/d',this.pipeName,'/f'],options)
    for(const vendor of ['Google\\Chrome','Microsoft\\Edge']) await run(reg,['add',`HKCU\\Software\\${vendor}\\NativeMessagingHosts\\net.hellodog.google_voice`,'/ve','/t','REG_SZ','/d',manifest,'/f'],options)
  }
}
