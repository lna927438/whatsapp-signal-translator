import {officialBillSummary,sumOfficialAmounts,type BillPeriod,type BillProvider,type OfficialBillSummary,type OfficialBill} from './officialBills'
import {usd} from './money'
type Row=Record<string,unknown>

/** Match DeepSeek's official statement display: decimal truncation only.
 * The exact statement amount remains unchanged for totals, storage and tooltips. */
export function deepseekOfficialAmount(value:unknown):string {
  if(typeof value!=='string')return '待核算'
  const match=/^(-?)(\d+)(?:\.(\d{1,12}))?$/.exec(value)
  if(!match)return '待核算'
  const whole=match[2].replace(/^0+(?=\d)/,''),fraction=(match[3]||'').slice(0,2).padEnd(2,'0')
  const sign=match[1]&&(whole!=='0'||fraction!=='00')?'-':''
  return `${sign}$${whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')}.${fraction}`
}
export function officialAmount(bill:OfficialBill):string {
  return bill.provider==='deepseek'?deepseekOfficialAmount(bill.amount):usd(bill.amount)
}

/** The two-channel headline is complete only when both current-account bills
 * passed the existing period/currency/source validation. A selected or retired
 * channel never turns a partial bill into a complete two-channel total. */
export function officialCostCards(data:Row,period:BillPeriod,now=Date.now()):OfficialBillSummary {
  const summary=officialBillSummary(data,period,now)
  const required:BillProvider[]=['deepseek','openai']
  const missing=required.filter(provider=>!summary.items.some(item=>item.provider===provider))
  const partial=sumOfficialAmounts(summary.items.map(item=>item.amount))
  return {...summary,missing,partial,complete:missing.length===0,total:missing.length===0?partial:null}
}

export function costRecordCount(value:unknown):number|null {
  const count=typeof value==='number'?value:typeof value==='string'&&/^\d+$/.test(value)?Number(value):NaN
  return Number.isSafeInteger(count)&&count>=0?count:null
}

/** A receipt subtotal is usable only when the server actually supplied money.
 * Missing pricing must stay visible; a known zero is never a complete bill. */
export function receiptCost(row:Row|null|undefined):{amount:string|null;pending:number|null;partial:boolean} {
  if(!row)return {amount:null,pending:null,partial:true}
  const raw=row.known_cost_usd_exact??row.known_cost_usd??row.cost_usd
  const amount=typeof raw==='string'?sumOfficialAmounts([raw]):typeof raw==='number'&&Number.isFinite(raw)?String(raw):null
  const pending=costRecordCount(row.unpriced_requests)
  return {amount,pending,partial:amount===null||pending===null||pending>0}
}

/** Never fabricate a per-channel zero when its breakdown was not returned. */
export function providerReceipt(data:Row,name:BillProvider):Row|null {
  if(!data.totals||!Array.isArray(data.providers))return null
  const rows=data.providers.filter(row=>row&&typeof row==='object'&&row.provider===name)
  if(rows.length>1)return null
  return rows[0]??{known_cost_usd_exact:'0',requests:0,unpriced_requests:0,total_tokens:0}
}

/** Historical unscoped rows remain in the all-provider report. Surface their
 * count without assigning them to either current provider or inventing calls. */
export function unattributedCostRecords(totals:Row|undefined,providers:unknown):number|null {
  const total=costRecordCount(totals?.unpriced_requests)
  if(total===null||!Array.isArray(providers))return null
  const seen=new Set<string>();let known=0
  for(const row of providers){
    if(!row||typeof row!=='object')return null
    if(row.provider!=='openai'&&row.provider!=='deepseek')continue
    if(seen.has(row.provider))return null
    seen.add(row.provider)
    const count=costRecordCount(row.unpriced_requests)
    if(count===null||!Number.isSafeInteger(known+count))return null
    known+=count
  }
  return Math.max(0,total-known)
}
