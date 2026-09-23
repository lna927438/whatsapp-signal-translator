export type BillProvider='openai'|'deepseek'
export type BillPeriod={from:string;to:string;timezone:string;provider:string;officialCurrentMonth?:string}
type Row=Record<string,unknown>
export type OfficialBill={provider:BillProvider;amount:string;fetchedAt:string;source:string;provisional:boolean;timezone:'UTC'|'Asia/Shanghai';from:string;to:string}
export type OfficialBillSummary={complete:boolean;total:string|null;partial:string|null;missing:BillProvider[];items:OfficialBill[]}
const scale=1000000000000n

/** Absent metadata is the legacy dual-provider contract; malformed or empty
 * explicit metadata cannot silently re-enable a retired provider. */
export function enabledBillProviders(data:Row):BillProvider[]{
  if(!Object.hasOwn(data,'enabledProviders'))return ['openai','deepseek']
  const value=data.enabledProviders
  if(!Array.isArray(value)||value.some(item=>item!=='openai'&&item!=='deepseek')||new Set(value).size!==value.length)return []
  return value as BillProvider[]
}
export function selectedBillProviders(data:Row,period:BillPeriod):BillProvider[]{
  const enabled=enabledBillProviders(data)
  return period.provider?enabled.filter(provider=>provider===period.provider):enabled
}

/** Current-period imported statements age too: repeatedly reading one does not
 * make its amount current. The UI separately explains how each source updates. */
export function officialBillDelayed(summary:OfficialBillSummary,period:BillPeriod,now=Date.now()):boolean {
  return summary.items.some(item=>{const range=period.officialCurrentMonth==='true'?item:period,today=currentBillPeriod(item.timezone,now).to;return range.to>=today&&range.from<=today&&now-Date.parse(item.fetchedAt)>10*60000})
}

export function officialBillNotice(item:OfficialBill|undefined,period:BillPeriod,now=Date.now()):string {
  if(!item)return ''
  if(item.source==='manual_statement')return '手动账单不会自动更新，新增费用需重新导入。'
  return officialBillDelayed({items:[item],complete:true,total:item.amount,partial:item.amount,missing:[]},period,now)
    ?'官方同步有延迟，保留上次金额。':'官方账单可能延迟补记。'
}

/** Headline status belongs to the supplier snapshot, never to a newer page read. */
export function officialBillStatus(item:OfficialBill|undefined,period:BillPeriod,now=Date.now()):string {
  if(!item)return '尚未同步'
  const today=currentBillPeriod(item.timezone,now).to
  if(item.to<today)return item.provisional?'历史账单快照':'历史官方账单'
  if(item.source==='manual_statement')return now-Date.parse(item.fetchedAt)>10*60000?'上次导出金额 · 待更新':'官方导出快照'
  return officialBillDelayed({items:[item],complete:true,total:item.amount,partial:item.amount,missing:[]},period,now)?'同步延迟 · 保留上次金额':'官方自动同步'
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
  const selected=selectedBillProviders(data,period)
  const empty=():OfficialBillSummary=>({complete:false,total:null,partial:null,missing:selected,items:[]})
  const start=day(period.from),end=day(period.to),offset=period.timezone==='Asia/Shanghai'?8*60*60*1000:0
  if(!selected.length||start===null||end===null||end<start||!['UTC','Asia/Shanghai'].includes(period.timezone)||!['','openai','deepseek'].includes(period.provider))return empty()
  const from=start-offset,to=end+86400000-offset
  const referenceNow=instant(data.snapshotAt)??now
  // Business statistics retain their selected timezone; official bills cover
  // the same calendar dates in each provider's own reporting timezone.
  if(data.timezone!==period.timezone||instant(data.from)!==from||instant(data.toExclusive)!==to||!Array.isArray(data.officialBills))return empty()
  const basis=data.officialBillingBasis as Row|undefined,zones=basis?.timezones as Row|undefined,nativeMonth=period.officialCurrentMonth==='true'
  if(zones?.openai!=='UTC'||zones?.deepseek!=='Asia/Shanghai')return empty()
  if(nativeMonth){
    if(basis?.kind!=='provider_current_month'||instant(data.snapshotAt)===null)return empty()
  }else if(basis?.kind!=='provider_reporting_period'||basis.from!==period.from||basis.to!==period.to)return empty()
  const items:OfficialBill[]=[]
  for(const provider of selected){
    const candidates=data.officialBills.filter((value):value is Row=>Boolean(value)&&typeof value==='object'&&(value as Row).provider===provider)
    if(candidates.length!==1)continue
    const bill=candidates[0]
    if(bill.currentAccount!==true||bill.periodComplete!==true||bill.currency!=='USD')continue
    const billTimezone=provider==='openai'?'UTC':'Asia/Shanghai',billOffset=provider==='deepseek'?28800000:0
    const providerPeriod=nativeMonth?currentBillPeriod(billTimezone,referenceNow):period
    if(nativeMonth){
      const periods=basis?.periods as Row|undefined,reported=periods?.[provider] as Row|undefined
      if(reported?.from!==providerPeriod.from||reported?.to!==providerPeriod.to||reported?.timezone!==billTimezone)continue
    }
    const billFrom=Date.parse(providerPeriod.from+'T00:00:00Z')-billOffset,billTo=Date.parse(providerPeriod.to+'T00:00:00Z')+86400000-billOffset
    const fetchedAt=instant(bill.fetched_at)
    if(bill.timezone!==billTimezone||instant(bill.period_from)!==billFrom||instant(bill.period_to)!==billTo||fetchedAt===null||fetchedAt>referenceNow+60000)continue
    const amount=sumOfficialAmounts([bill.official_usd_exact])
    if(amount===null||!['openai_costs_api','manual_statement'].includes(String(bill.source))||(bill.source==='openai_costs_api'&&provider!=='openai'))continue
    items.push({provider,amount,fetchedAt:String(bill.fetched_at),source:String(bill.source),provisional:bill.provisional!==false,timezone:billTimezone,from:providerPeriod.from,to:providerPeriod.to})
  }
  const missing=selected.filter(provider=>!items.some(item=>item.provider===provider)),partial=sumOfficialAmounts(items.map(item=>item.amount))
  return {complete:missing.length===0,total:missing.length===0?partial:null,partial,missing,items}
}
