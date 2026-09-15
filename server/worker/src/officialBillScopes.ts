import {currentOpenAIBillingScope,type BillingSyncEnv} from './billingSync'
import {deepSeekCredentialDigest} from './deepseekBalance'

// Kept on the server: the browser can select a date range, never an account.
export async function currentOfficialBillScopes(env:BillingSyncEnv){
 const credentialDigest=await deepSeekCredentialDigest(env.DEEPSEEK_API_KEY)
 return {openai:currentOpenAIBillingScope(env),deepseek:credentialDigest?{credentialDigest}:null}
}

export function officialReportingBasis(filter:Record<string,unknown>){
 const zone=filter.timezone==='UTC'?'UTC':'Asia/Shanghai'
 return {kind:'provider_reporting_period' as const,from:String(filter.from||'2026-01-01'),
  to:String(filter.to||new Intl.DateTimeFormat('sv-SE',{timeZone:zone}).format(new Date())),
  timezones:{openai:'UTC' as const,deepseek:'Asia/Shanghai' as const}}
}
