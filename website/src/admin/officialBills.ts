export type BillProvider='openai'|'deepseek'
export type BillPeriod={from:string;to:string;timezone:string;provider:string}
type Row=Record<string,unknown>
export type OfficialBill={provider:BillProvider;amount:string;fetchedAt:string;source:string;provisional:boolean;timezone:'UTC'|'Asia/Shanghai'}
export type OfficialBillSummary={complete:boolean;total:string|null;partial:string|null;missing:BillProvider[];items:OfficialBill[]}
const scale=1000000000000n

/** Only automatically collected current-period bills have a freshness deadline.
 * A manual DeepSeek statement must never be described as an automatic sync. */
export function officialBillDelayed(summary:OfficialBillSummary,period:BillPeriod,now=Date.now()):boolean {
  return summary.items.some(item=>item.source==='openai_costs_api'&&period.to>=currentBillPeriod(item.timezone,now).to&&now-Date.parse(item.fetchedAt)>10*60000)
}

export function currentBillPeriod(timezone:string,now=Date.now()):{from:string;to:string}{
  const to=new Date(now+(timezone==='Asia/Shanghai'?28800000:0)).toISOString().slice(0,10)
  return {from:to.slice(0,8)+'01',to}
}

/** Monetary values never pass through a floating-point number. */
export function sumOfficialAmounts(values:unknown[]):string|null {
  if(!values.length)return null
  let total=0n
  for(const value of values){
    if(typeof value!=='string')return null
    const match=/^(-?)(\d{1,12})(?:\.(\d{1,12}))?$/.exec(value)
    if(!match)return null
    total+=(match[1]?-1n:1n)*(BigInt(match[2])*scale+BigInt((match[3]||'').padEnd(12,'0')))
  }
  const absolute=total<0n?-total:total,fraction=(absolute%scale).toString().padStart(12,'0').replace(/0+$/,'')
  return `${total<0n?'-':''}${absolute/scale}${fraction?'.'+fraction:''}`
}
function day(value:string):number|null {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return null
  const time=Date.parse(value+'T00:00:00Z')
  return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===value?time:null
}
function instant(value:unknown):number|null {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))return null
  const time=Date.parse(value);return Number.isFinite(time)?time:null
}
export function officialBillSummary(data:Row,period:BillPeriod,now=Date.now()):OfficialBillSummary {
  const selected:BillProvider[]=period.provider==='openai'||period.provider==='deepseek'?[period.provider]:['openai','deepseek']
  const empty=():OfficialBillSummary=>({complete:false,total:null,partial:null,missing:selected,items:[]})
  const start=day(period.from),end=day(period.to),offset=period.timezone==='Asia/Shanghai'?8*60*60*1000:0
  if(start===null||end===null||end<start||!['UTC','Asia/Shanghai'].includes(period.timezone)||!['','openai','deepseek'].includes(period.provider))return empty()
  const from=start-offset,to=end+86400000-offset
  const referenceNow=instant(data.snapshotAt)??now
  // Business statistics retain their selected timezone; official bills cover
  // the same calendar dates in each provider's own reporting timezone.
  if(data.timezone!==period.timezone||instant(data.from)!==from||instant(data.toExclusive)!==to||!Array.isArray(data.officialBills))return empty()
  const basis=data.officialBillingBasis as Row|undefined,zones=basis?.timezones as Row|undefined
  if(basis?.kind!=='provider_reporting_period'||basis.from!==period.from||basis.to!==period.to||zones?.openai!=='UTC'||zones?.deepseek!=='Asia/Shanghai')return empty()
  const items:OfficialBill[]=[]
  for(const provider of selected){
    const candidates=data.officialBills.filter((value):value is Row=>Boolean(value)&&typeof value==='object'&&(value as Row).provider===provider)
    if(candidates.length!==1)continue
    const bill=candidates[0]
    if(bill.currentAccount!==true||bill.periodComplete!==true||bill.currency!=='USD')continue
    const billTimezone=provider==='openai'?'UTC':'Asia/Shanghai',billOffset=provider==='deepseek'?28800000:0
    const fetchedAt=instant(bill.fetched_at)
    if(bill.timezone!==billTimezone||instant(bill.period_from)!==start-billOffset||instant(bill.period_to)!==end+86400000-billOffset||fetchedAt===null||fetchedAt>referenceNow+60000)continue
    const amount=sumOfficialAmounts([bill.official_usd_exact])
    if(amount===null||!['openai_costs_api','manual_statement'].includes(String(bill.source))||(bill.source==='openai_costs_api'&&provider!=='openai'))continue
    items.push({provider,amount,fetchedAt:String(bill.fetched_at),source:String(bill.source),provisional:bill.provisional!==false,timezone:billTimezone})
  }
  const missing=selected.filter(provider=>!items.some(item=>item.provider===provider)),partial=sumOfficialAmounts(items.map(item=>item.amount))
  return {complete:missing.length===0,total:missing.length===0?partial:null,partial,missing,items}
}
