import { JsonStore } from './jsonStore'
import { noticeKey, type ClientNotice } from '../../shared/clientNotices'
type Entry={id:string;revision:number;displayed:boolean;dismissed:boolean;displayAck:boolean;dismissAck:boolean;at:number}
type Data={owners:Record<string,Record<string,Entry>>}
export class NoticeJournal {
  private writes:Promise<unknown>=Promise.resolve()
  constructor(private store:Pick<JsonStore<Data>,'read'|'write'>=new JsonStore<Data>('notification-receipts.json',{owners:{}})){}
  private change(owner:string,notice:Pick<ClientNotice,'id'|'revision'>,update:(entry:Entry)=>void) {
    const work=this.writes.catch(()=>{}).then(async()=>{
      const data=await this.store.read();data.owners ||= {};const entries=data.owners[owner] ||= {},key=noticeKey(notice)
      const entry=entries[key] ||= {id:notice.id,revision:notice.revision,displayed:false,dismissed:false,displayAck:false,dismissAck:false,at:Date.now()};update(entry);entry.at=Date.now()
      const removable=Object.entries(entries).filter(([,e])=>(!e.displayed||e.displayAck)&&(!e.dismissed||e.dismissAck)).sort((a,b)=>a[1].at-b[1].at)
      while(Object.keys(entries).length>1000&&removable.length)delete entries[removable.shift()![0]]
      await this.store.write(data)
    });this.writes=work;return work
  }
  async entries(owner:string){await this.writes.catch(()=>{});return (await this.store.read()).owners?.[owner]||{}}
  record(owner:string,notice:Pick<ClientNotice,'id'|'revision'>,state:'displayed'|'dismissed') {return this.change(owner,notice,e=>{e[state]=true})}
  acknowledged(owner:string,notice:Pick<ClientNotice,'id'|'revision'>,state:'displayed'|'dismissed'){return this.change(owner,notice,e=>{e[state==='displayed'?'displayAck':'dismissAck']=true})}
  async pending(owner:string){return Object.values(await this.entries(owner)).flatMap(e=>(['displayed','dismissed'] as const).filter(state=>e[state]&&!e[state==='displayed'?'displayAck':'dismissAck']).map(state=>({id:e.id,revision:e.revision,state}))).slice(0,12)}
}
