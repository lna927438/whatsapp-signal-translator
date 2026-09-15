// Official cost snapshots never replace token receipts or customer character
// debits. A project inference key must never be used as an organization key.
import {refreshDeepSeekBalance} from './deepseekBalance'
export interface BillingSyncEnv {
  DEEPSEEK_API_KEY?: string
  OPENAI_BILLING_ADMIN_KEY?: string
  OPENAI_BILLING_PROJECT_ID?: string
  OPENAI_BILLING_API_KEY_IDS?: string
  SUPABASE_URL: string
  SUPABASE_SECRET_KEY: string
}
export class BillingSyncError extends Error {
  constructor(readonly code: 'billing_not_configured'|'billing_permission'|'billing_data_incomplete'|'billing_unavailable'|'invalid_request') { super(code) }
}
const invalid = (): never => { throw new BillingSyncError('billing_data_incomplete') }
const projectPattern=/^proj_[A-Za-z0-9_-]{1,160}$/
const keyPattern=/^key_[A-Za-z0-9_-]{1,160}$/
function configured(env:BillingSyncEnv){
  const projectId=String(env.OPENAI_BILLING_PROJECT_ID||'').trim()
  const apiKeyIds=[...new Set(String(env.OPENAI_BILLING_API_KEY_IDS||'').split(',').map(v=>v.trim()).filter(Boolean))].sort()
  const adminKey=String(env.OPENAI_BILLING_ADMIN_KEY||'').trim()
  const reason=!adminKey?'admin_key_missing':!projectPattern.test(projectId)||!apiKeyIds.length||apiKeyIds.length>20||apiKeyIds.some(id=>!keyPattern.test(id))?'scope_missing':null
  return {projectId,apiKeyIds,adminKey,reason}
}
export function currentOpenAIBillingScope(env:BillingSyncEnv){
  const scope=configured(env)
  return scope.reason?null:{projectId:scope.projectId,apiKeyIds:scope.apiKeyIds}
}
export function billingSyncStatus(env:BillingSyncEnv){
  const c=configured(env)
  return {provider:'openai',configured:c.reason===null,reason:c.reason,timezone:'UTC',
    officialSource:'https://platform.openai.com/usage',provisional:true,
    message:c.reason==='admin_key_missing'?'尚未连接官方账单读取权限。':c.reason==='scope_missing'?'尚未指定 HelloDog 的账单范围。':'已连接账单读取配置，实际权限将在同步时核验。'}
}
export function billingRange(value:unknown,now=Date.now()){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new BillingSyncError('invalid_request')
  const v=value as Record<string,unknown>
  if(Object.keys(v).some(k=>!['from','to'].includes(k)))throw new BillingSyncError('invalid_request')
  const day=(x:unknown)=>{if(typeof x!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(x))throw new BillingSyncError('invalid_request');const n=Date.parse(x+'T00:00:00Z');if(!Number.isFinite(n)||new Date(n).toISOString().slice(0,10)!==x)throw new BillingSyncError('invalid_request');return n}
  const start=day(v.from),end=day(v.to)+86400000
  if(end<=start||end-start>93*86400000||end>Math.floor(now/86400000)*86400000+86400000)throw new BillingSyncError('invalid_request')
  return {from:String(v.from),to:String(v.to),start:Math.floor(start/1000),end:Math.floor(end/1000)}
}
// Accumulate original decimal lexemes as trillionths of USD. Never add money
// with binary floating point or round missing billing precision into zero.
export function usdUnits(value:unknown):bigint {
  if(typeof value!=='string'||value.length>80)return invalid()
  const m=/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d{1,2}))?$/.exec(value)
  if(!m)return invalid()
  const fraction=m[3]||'',power=12-fraction.length+Number(m[4]||0),digits=BigInt(m[2]+fraction)*(m[1]? -1n:1n)
  if(Math.abs(power)>40)return invalid()
  if(power>=0)return digits*10n**BigInt(power)
  const divisor=10n**BigInt(-power);if(digits%divisor!==0n)return invalid();return digits/divisor
}
export function unitsUsd(value:bigint){
  const absolute=value<0n?-value:value
  if(absolute>=1_000_000_000n*1_000_000_000_000n)return invalid()
  return `${value<0n?'-':''}${absolute/1_000_000_000_000n}.${String(absolute%1_000_000_000_000n).padStart(12,'0')}`
}
export async function syncOfficialCosts(env:BillingSyncEnv,rangeValue:unknown,now=Date.now()){
  const scope=configured(env),range=billingRange(rangeValue,now)
  if(scope.reason)throw new BillingSyncError('billing_not_configured')
  const bucketTotals=new Map<number,bigint>(),seenPages=new Set<string>();let page:string|undefined,totalRows=0
  for(let index=0;index<10;index++){
    const url=new URL('https://api.openai.com/v1/organization/costs')
    url.searchParams.set('start_time',String(range.start));url.searchParams.set('end_time',String(range.end));url.searchParams.set('bucket_width','1d');url.searchParams.set('limit','93')
    url.searchParams.append('project_ids[]',scope.projectId)
    for(const id of scope.apiKeyIds)url.searchParams.append('api_key_ids[]',id)
    for(const key of ['project_id','api_key_id','line_item'])url.searchParams.append('group_by[]',key)
    if(page)url.searchParams.set('page',page)
    let response:Response
    // workerd supports manual/follow only; reject redirects without forwarding credentials.
    try{response=await fetch(url,{headers:{Authorization:`Bearer ${scope.adminKey}`},redirect:'manual',signal:AbortSignal.timeout(8000)})}catch{throw new BillingSyncError('billing_unavailable')}
    if(response.status===401||response.status===403)throw new BillingSyncError('billing_permission')
    if(!response.ok)throw new BillingSyncError('billing_unavailable')
    const raw=await response.text();if(raw.length>2_000_000)return invalid()
    let payload:any
    try{payload=JSON.parse(raw.replace(/("value"\s*:\s*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s*[,}])/g,'$1"$2"'))}catch{return invalid()}
    if(payload?.object!=='page'||!Array.isArray(payload.data)||typeof payload.has_more!=='boolean')return invalid()
    for(const bucket of payload.data){
      if(bucket?.object!=='bucket'||!Number.isSafeInteger(bucket.start_time)||bucket.start_time<range.start||bucket.end_time>range.end
        ||bucket.start_time%86400!==0||bucket.end_time!==bucket.start_time+86400||!Array.isArray(bucket.results)||bucketTotals.has(bucket.start_time))return invalid()
      let amount=0n
      for(const row of bucket.results){
        if(++totalRows>10000||row?.object!=='organization.costs.result'||row.project_id!==scope.projectId
          ||!scope.apiKeyIds.includes(row.api_key_id)||row.amount?.currency!=='usd')return invalid()
        amount+=usdUnits(row.amount.value)
      }
      bucketTotals.set(bucket.start_time,amount)
    }
    if(!payload.has_more)break
    if(typeof payload.next_page!=='string'||!payload.next_page||payload.next_page.length>400||seenPages.has(payload.next_page)||index===9)return invalid()
    const nextPage:string=payload.next_page;page=nextPage;seenPages.add(nextPage)
  }
  // A missing bucket or truncated page is incomplete, never a zero-cost day.
  for(let day=range.start;day<range.end;day+=86400)if(!bucketTotals.has(day))return invalid()
  const officialUsd=unitsUsd([...bucketTotals.values()].reduce((n,v)=>n+v,0n)),fetchedAt=new Date().toISOString(),id=crypto.randomUUID()
  const body={p_id:id,p_from:new Date(range.start*1000).toISOString(),p_to:new Date(range.end*1000).toISOString(),
    p_scope:{projectId:scope.projectId,apiKeyIds:scope.apiKeyIds},p_usd:officialUsd,p_fetched_at:fetchedAt}
  let saved=false
  for(let retry=0;retry<2;retry++){
    try{const result=await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/record_official_bill`,{method:'POST',headers:{apikey:env.SUPABASE_SECRET_KEY,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});if(result.ok){saved=true;break}}catch{/* Repeat only identical snapshot storage, never invent a new operation. */}
  }
  if(!saved)throw new BillingSyncError('billing_unavailable')
  return {id,provider:'openai',from:range.from,to:range.to,timezone:'UTC',officialUsd,fetchedAt,provisional:true,
    message:'官方账单快照已同步。近期用量可能继续入账，最终以官方账单为准。'}
}
export async function syncRecentOfficialCosts(env:BillingSyncEnv,now=Date.now()){
  if(!billingSyncStatus(env).configured)return {skipped:true,reason:'not_configured'}
  const to=new Date(now).toISOString().slice(0,10)
  return syncOfficialCosts(env,{from:to.slice(0,8)+'01',to},now)
}

export async function syncDeepSeekBalance(env:BillingSyncEnv){
  return refreshDeepSeekBalance(env)
}
/** Scheduled job: either provider may succeed independently. No balance-delta accounting. */
export async function syncBillingSnapshots(env:BillingSyncEnv,now=Date.now()){
  const results=await Promise.allSettled([syncRecentOfficialCosts(env,now),syncDeepSeekBalance(env)])
  return Object.fromEntries(results.map((result,index)=>[index===0?'openai':'deepseek',result.status==='fulfilled'?result.value:
    {error:result.reason instanceof BillingSyncError?result.reason.code:'billing_unavailable'}]))
}
