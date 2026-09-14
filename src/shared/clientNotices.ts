export interface ClientNotice {
  id:string; revision:number; title:string; body:string; level:'info'|'warning'|'critical'; popup:boolean
  action:'none'|'website'|'download'; starts_at:string; ends_at:string|null; displayed:boolean; dismissed:boolean
}
export function noticeKey(value: Pick<ClientNotice,'id'|'revision'>) { return value.id+':'+value.revision }
export function clientNotices(value: unknown): ClientNotice[] {
  const input=(value as any)?.notices
  if(!Array.isArray(input)||input.length>100)throw new Error('通知信息暂时不可用。')
  return input.map(item=>{
    if(!item||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.id)
      ||!Number.isSafeInteger(item.revision)||item.revision<1||item.revision>2147483647
      ||typeof item.title!=='string'||!item.title.trim()||item.title.length>120||typeof item.body!=='string'||item.body.length>10000
      ||!['info','warning','critical'].includes(item.level)||!['none','website','download'].includes(item.action)
      ||typeof item.popup!=='boolean'||typeof item.displayed!=='boolean'||typeof item.dismissed!=='boolean'
      ||!Number.isFinite(Date.parse(item.starts_at))||(item.ends_at!==null&&!Number.isFinite(Date.parse(item.ends_at))))throw new Error('通知信息暂时不可用。')
    return {id:item.id,revision:item.revision,title:item.title,body:item.body,level:item.level,popup:item.popup,action:item.action,
      starts_at:item.starts_at,ends_at:item.ends_at,displayed:item.displayed,dismissed:item.dismissed}
  })
}
export function noticeActionUrl(action: ClientNotice['action']) {
  return action==='website'?'https://hellodog.net/':action==='download'?'https://hellodog.net/download':null
}
export function noticeWindowBounds(parent:{x:number;y:number;width:number;height:number}) {
  const width=Math.max(240,Math.min(360,parent.width-32)),height=Math.max(160,Math.min(246,parent.height-120))
  return {x:Math.round(parent.x+parent.width-width-16),y:Math.round(parent.y+parent.height-height-76),width,height}
}
