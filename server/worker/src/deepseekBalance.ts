import type {BillingSyncEnv} from './billingSync'

type BalanceError='provider_permission'|'provider_rate_limited'|'provider_unavailable'|'provider_invalid_response'|'storage_unavailable'|'timeout'
export interface DeepSeekBalanceStatus {
 provider:'deepseek';available:boolean|null;balances:Array<{currency:'USD'|'CNY';total:string;granted:string;paid:string}>
 fetchedAt:string|null;snapshotAt:string|null;checkedAt:string;stale:boolean
 sync:{status:'fresh'|'refreshing'|'stale'|'error'|'not_configured';lastAttemptAt:string|null;lastError:string|null;lastErrorAt:string|null;nextRefreshAt:string|null;refreshIntervalSeconds:30;staleAfterSeconds:120}
}
const emptyStatus=():DeepSeekBalanceStatus=>({provider:'deepseek',available:null,balances:[],fetchedAt:null,snapshotAt:null,checkedAt:new Date().toISOString(),stale:true,
 sync:{status:'not_configured',lastAttemptAt:null,lastError:null,lastErrorAt:null,nextRefreshAt:null,refreshIntervalSeconds:30,staleAfterSeconds:120}})
class BalanceFailure extends Error{constructor(readonly code:BalanceError){super(code)}}

// The provider publishes strings, not floating point amounts. Keep every digit
// and each currency separately; a balance change is not a spending statement.
export function parseDeepSeekBalance(data:unknown){
 const invalid=():never=>{throw new BalanceFailure('provider_invalid_response')}
 if(!data||typeof data!=='object')return invalid()
 const payload=data as {is_available?:unknown;balance_infos?:unknown}
 if(typeof payload.is_available!=='boolean'||!Array.isArray(payload.balance_infos)||payload.balance_infos.length<1||payload.balance_infos.length>2)return invalid()
 const decimal=(value:unknown)=>typeof value==='string'&&/^-?\d{1,12}(\.\d{1,12})?$/.test(value)?value:invalid()
 const units=(value:string)=>{const negative=value.startsWith('-'),[whole,fraction='']=(negative?value.slice(1):value).split('.');return BigInt(whole+fraction.padEnd(12,'0'))*(negative?-1n:1n)}
 const seen=new Set<string>(),balances=payload.balance_infos.map(value=>{
  if(!value||typeof value!=='object')return invalid()
  const row=value as Record<string,unknown>,currency=row.currency
  if((currency!=='USD'&&currency!=='CNY')||seen.has(currency))return invalid();seen.add(currency)
  const total=decimal(row.total_balance),granted=decimal(row.granted_balance),paid=decimal(row.topped_up_balance)
  if(units(total)!==units(granted)+units(paid))return invalid()
  return {currency,total,granted,paid}
 })
 return {available:payload.is_available,balances}
}

export async function deepSeekCredentialDigest(keyValue:string|undefined):Promise<string|null>{
 const key=String(keyValue||'').trim();if(!key)return null
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('deepseek-balance-v1:'+key))
 return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')
}

async function balanceRpc(env:BillingSyncEnv,name:string,args:Record<string,unknown>){
 const result=await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`,{method:'POST',headers:{apikey:env.SUPABASE_SECRET_KEY,'Content-Type':'application/json'},
  body:JSON.stringify(args),redirect:'manual',signal:AbortSignal.timeout(5000)})
 if(!result.ok)throw new BalanceFailure('storage_unavailable')
 const data=await result.json() as DeepSeekBalanceStatus&{claimed?:boolean;ignored?:boolean}
 if(!data||typeof data!=='object')throw new BalanceFailure('storage_unavailable')
 return data
}
function publicStatus(data:DeepSeekBalanceStatus&{claimed?:boolean;ignored?:boolean}):DeepSeekBalanceStatus{
 if(data.provider!=='deepseek'||!data.sync)throw new BalanceFailure('storage_unavailable')
 const {claimed,ignored,...status}=data;return status
}

export async function refreshDeepSeekBalance(env:BillingSyncEnv):Promise<DeepSeekBalanceStatus>{
 const key=String(env.DEEPSEEK_API_KEY||'').trim();if(!key)return emptyStatus()
 // A credential change invalidates the displayed account snapshot. The digest
 // stays in the private ledger and is never returned to an admin browser.
 const scope=await deepSeekCredentialDigest(key),token=crypto.randomUUID()
 const args={p_scope:scope,p_token:token}
 const claim=await balanceRpc(env,'claim_deepseek_balance_refresh',args)
 if(!claim.claimed)return publicStatus(claim)
 let payload:unknown=null,error:BalanceError|null=null
 try{
  const response=await fetch('https://api.deepseek.com/user/balance',{headers:{Authorization:`Bearer ${key}`},redirect:'manual',signal:AbortSignal.timeout(8000)})
  if(!response.ok)throw new BalanceFailure(response.status===401||response.status===403?'provider_permission':response.status===429?'provider_rate_limited':'provider_unavailable')
  const raw=await response.text();if(raw.length>16384)throw new BalanceFailure('provider_invalid_response')
  let parsed:unknown;try{parsed=JSON.parse(raw)}catch{throw new BalanceFailure('provider_invalid_response')}
  payload={...parseDeepSeekBalance(parsed),fetchedAt:new Date().toISOString()}
 }catch(cause){error=cause instanceof BalanceFailure?cause.code:cause instanceof Error&&(cause.name==='TimeoutError'||cause.name==='AbortError')?'timeout':'provider_unavailable'}
 // A lost database reply retries one identical token/result. It never repeats
 // the provider query or creates a second balance observation.
 for(let retry=0;retry<2;retry++)try{return publicStatus(await balanceRpc(env,'finish_deepseek_balance_refresh',{...args,p_result:payload,p_error:error}))}catch{
  if(retry===1)return {...publicStatus(claim),checkedAt:new Date().toISOString(),stale:true,sync:{...claim.sync,status:'error',lastError:'storage_unavailable',lastErrorAt:new Date().toISOString()}}
 }
 throw new BalanceFailure('storage_unavailable')
}
