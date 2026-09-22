import {currentOpenAIBillingScope,enabledBillingProviders,type BillingSyncEnv} from './billingSync'
import {deepSeekCredentialDigest} from './deepseekBalance'

// Kept on the server: the browser can select a date range, never an account.
export async function currentOfficialBillScopes(env:BillingSyncEnv){
 const credentialDigest=enabledBillingProviders(env).includes('deepseek')?await deepSeekCredentialDigest(env.DEEPSEEK_API_KEY):null
 return {openai:currentOpenAIBillingScope(env),deepseek:credentialDigest?{credentialDigest}:null}
}

export function officialReportingBasis(filter:Record<string,unknown>){
 const zone=filter.timezone==='UTC'?'UTC':'Asia/Shanghai'
 return {kind:'provider_reporting_period' as const,from:String(filter.from||'2026-01-01'),
  to:String(filter.to||new Intl.DateTimeFormat('sv-SE',{timeZone:zone}).format(new Date())),
  timezones:{openai:'UTC' as const,deepseek:'Asia/Shanghai' as const}}
}

/** Overview uses each supplier's own current month, including the UTC/GMT+8
 * midnight gap. User-selected historical reporting periods keep their contract. */
export function currentMonthOfficialReportingBasis(now=Date.now()){
 const period=(timezone:'UTC'|'Asia/Shanghai')=>{
  const to=new Date(now+(timezone==='Asia/Shanghai'?28800000:0)).toISOString().slice(0,10)
  return {from:to.slice(0,8)+'01',to,timezone}
 }
 return {kind:'provider_current_month' as const,
  periods:{openai:period('UTC'),deepseek:period('Asia/Shanghai')},
  timezones:{openai:'UTC' as const,deepseek:'Asia/Shanghai' as const}}
}
