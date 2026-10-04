import {fundingDecimal,parseProviderFunding,type ProviderFunding} from './providerFunding'
export type BalanceStatus='fresh'|'refreshing'|'stale'|'error'|'not_configured'
export interface ProviderBalance {
  provider:'deepseek'
  available:boolean|null
  balances:Array<{currency:'USD'|'CNY';total:string;granted:string;paid:string}>
  fetchedAt:string|null
  checkedAt:string
  stale:boolean
  sync:{status:BalanceStatus;nextRefreshAt:string|null;refreshIntervalSeconds:number;staleAfterSeconds:number}
  funding:ProviderFunding|null
}
const timestamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))
export function parseProviderBalance(value:unknown):ProviderBalance {
  const v=value as Record<string,any>|null
  const invalid=():never=>{throw Error('官方余额响应不完整，暂时保留上次结果。')}
  if(!v||v.provider!=='deepseek'||![true,false,null].includes(v.available)||!Array.isArray(v.balances)||v.balances.length>2||!timestamp(v.checkedAt)||typeof v.stale!=='boolean')return invalid()
  const fetchedAt=v.fetchedAt??v.snapshotAt??null
  if(fetchedAt!==null&&!timestamp(fetchedAt)||v.balances.length>0&&fetchedAt===null)return invalid()
  if(fetchedAt&&Date.parse(fetchedAt)>Date.parse(v.checkedAt)+5000)return invalid()
  const seen=new Set<string>()
  const balances=v.balances.map((row:any)=>{
    if(!row||!['USD','CNY'].includes(row.currency)||seen.has(row.currency)||['total','granted','paid'].some(key=>typeof row[key]!=='string'||! /^-?\d{1,12}(\.\d{1,12})?$/.test(row[key])))return invalid()
    if(fundingDecimal(row.total)!==fundingDecimal(row.paid)!+fundingDecimal(row.granted)!)return invalid()
    seen.add(row.currency);return {currency:row.currency,total:row.total,granted:row.granted,paid:row.paid}
  })
  const s=v.sync
  if(!s||!['fresh','refreshing','stale','error','not_configured'].includes(s.status)||!Number.isFinite(s.refreshIntervalSeconds)||s.refreshIntervalSeconds<1||!Number.isFinite(s.staleAfterSeconds)||s.staleAfterSeconds<1||s.nextRefreshAt!==null&&!timestamp(s.nextRefreshAt))return invalid()
  const funding=parseProviderFunding(v.funding,{balances,fetchedAt,checkedAt:v.checkedAt})
  return {provider:'deepseek',available:v.available,balances,fetchedAt,checkedAt:v.checkedAt,stale:v.stale,sync:{status:s.status,nextRefreshAt:s.nextRefreshAt,refreshIntervalSeconds:s.refreshIntervalSeconds,staleAfterSeconds:s.staleAfterSeconds},funding}
}
export function balanceState(balance:ProviderBalance|null,error:string,now=Date.now()):{label:string;delayed:boolean} {
  if(error)return {label:balance?.balances.length?'同步未完成，保留上次余额':'暂未取得官方余额',delayed:true}
  if(!balance)return {label:'尚未取得官方余额',delayed:false}
  if(balance.sync.status==='not_configured')return {label:'尚未连接余额查询',delayed:true}
  if(balance.sync.status==='error')return {label:balance.balances.length?'同步未完成，保留上次余额':'暂未取得官方余额',delayed:true}
  if(balance.sync.status==='refreshing')return {label:balance.balances.length?'正在同步，暂显示上次余额':'正在获取官方余额',delayed:true}
  if(balance.stale||balance.sync.status==='stale'||balance.fetchedAt&&now-Date.parse(balance.fetchedAt)>balance.sync.staleAfterSeconds*1000)return {label:'余额更新有延迟，等待刷新',delayed:true}
  return {label:balance.balances.length?'已与官方接口核对':'尚未取得官方余额',delayed:false}
}
export function utcTimestamp(value:unknown):string {return timestamp(value)?new Date(value).toISOString().slice(0,19).replace('T',' ')+' UTC':'尚无采集记录'}
