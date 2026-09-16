export interface ProviderFunding {
 basis:'confirmed_paid_funding_minus_official_paid_balance'
 scope:'current_account_lifetime'
 currency:'USD'
 status:'ready'|'stale'|'unconfigured'|'needs_confirmation'
 reason:string|null
 cumulativeTopUps:string|null
 cumulativeCashRefunds:string|null
 netPaidFunding:string|null
 paidBalance:string|null
 grantedBalance:string|null
 usedPaid:string|null
 balanceFetchedAt:string|null
 confirmedAt:string|null
 basisSource:'owner_confirmation'|null
}
const scale=10n**12n
export function fundingDecimal(value:unknown):bigint|null {
 if(typeof value!=='string'||!/^[-]?\d{1,12}(?:\.\d{1,12})?$/.test(value))return null
 const negative=value.startsWith('-'),parts=(negative?value.slice(1):value).split('.')
 return (BigInt(parts[0])*scale+BigInt((parts[1]||'').padEnd(12,'0')))*(negative?-1n:1n)
}
const time=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))
/** Verify server-computed money against the same official balance snapshot.
 * No number coercion, historical statement fallback or guessed zero baseline. */
export function parseProviderFunding(value:unknown,balance:{balances:Array<{currency:string;total:string;paid:string;granted:string}>;fetchedAt:string|null;checkedAt:string}):ProviderFunding|null {
 if(value===undefined||value===null)return null
 const v=value as Record<string,unknown>,invalid=():never=>{throw Error('累计资金数据未通过核对，保留上次结果。')}
 if(v.basis!=='confirmed_paid_funding_minus_official_paid_balance'||v.scope!=='current_account_lifetime'||v.currency!=='USD'||!['ready','stale','unconfigured','needs_confirmation'].includes(String(v.status))||![null,'owner_confirmation'].includes(v.basisSource as any)||v.reason!==null&&typeof v.reason!=='string')return invalid()
 const keys=['cumulativeTopUps','cumulativeCashRefunds','netPaidFunding','paidBalance','grantedBalance','usedPaid'] as const
 for(const key of keys)if(v[key]!==null&&fundingDecimal(v[key])===null)return invalid()
 for(const key of ['balanceFetchedAt','confirmedAt'])if(v[key]!==null&&!time(v[key]))return invalid()
 for(const key of ['cumulativeTopUps','cumulativeCashRefunds','netPaidFunding','usedPaid'])if(v[key]!==null&&fundingDecimal(v[key])!<0n)return invalid()
 if(['ready','stale'].includes(String(v.status))){
  if(keys.some(key=>v[key]===null)||v.basisSource!=='owner_confirmation'||!time(v.confirmedAt)||!time(v.balanceFetchedAt)||!time(balance.fetchedAt))return invalid()
  const row=balance.balances.find(item=>item.currency==='USD');if(!row)return invalid()
  if(Date.parse(v.balanceFetchedAt)!==Date.parse(balance.fetchedAt)||Date.parse(v.balanceFetchedAt)>Date.parse(balance.checkedAt)+5000||Date.parse(v.confirmedAt)>Date.parse(balance.checkedAt)+5000)return invalid()
  if(fundingDecimal(row.paid)!==fundingDecimal(v.paidBalance)||fundingDecimal(row.granted)!==fundingDecimal(v.grantedBalance)||fundingDecimal(row.total)!==fundingDecimal(row.paid)!+fundingDecimal(row.granted)!)return invalid()
  if(fundingDecimal(v.netPaidFunding)!==fundingDecimal(v.cumulativeTopUps)!-fundingDecimal(v.cumulativeCashRefunds)!||fundingDecimal(v.usedPaid)!==fundingDecimal(v.netPaidFunding)!-fundingDecimal(v.paidBalance)!)return invalid()
 }else if(v.usedPaid!==null)return invalid()
 return Object.fromEntries(['basis','scope','currency','status','reason',...keys,'balanceFetchedAt','confirmedAt','basisSource'].map(key=>[key,v[key]])) as unknown as ProviderFunding
}
