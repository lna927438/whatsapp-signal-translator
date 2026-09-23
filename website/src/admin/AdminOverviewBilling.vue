<script setup lang="ts">
import {computed,onMounted,onUnmounted,ref,watch} from 'vue'
import {request,fmt,usd,localPreview,type Row} from './client'
import {currentBillPeriod,enabledBillProviders,officialBillDelayed,officialBillNotice,officialBillStatus} from './officialBills'
import {parseProviderBalance,utcTimestamp,type ProviderBalance} from './providerBalance'
import ProviderFundingCard from './ProviderFundingCard.vue'
import {ReadPolling} from './readPolling'
import {adminTranslationChannel,type ChannelName} from './translationChannels'
import {officialCostCards,costRecordCount,unattributedCostRecords,officialAmount as formatOfficialAmount,providerReceipt,receiptCost} from './costCards'

const props=defineProps<{identity:string;canReadCosts:boolean;officialAccess:boolean}>()
const data=ref<Row>({}),busy=ref(false),error=ref(''),clock=ref(Date.now())
const queried=ref({...currentBillPeriod('UTC'),timezone:'UTC',provider:'',officialCurrentMonth:'true'})
const balance=ref<ProviderBalance|null>(null),balanceError=ref(''),balanceBusy=ref(false),balanceReadAt=ref(Date.now())
const balanceClock=computed(()=>balance.value?Date.parse(balance.value.checkedAt)+Math.max(0,clock.value-balanceReadAt.value):clock.value)
const deepseekEnabled=computed(()=>enabledBillProviders(data.value).includes('deepseek'))
const costs=computed(()=>data.value.totals as Row|undefined)
const costsReadAt=ref(Date.now())
const billingClock=computed(()=>{const snapshot=Date.parse(String(data.value.snapshotAt||''));return Number.isFinite(snapshot)?snapshot+Math.max(0,clock.value-costsReadAt.value):clock.value})
const official=computed(()=>officialCostCards(props.officialAccess?data.value:{},queried.value,clock.value))
const officialDelayed=computed(()=>officialBillDelayed(official.value,queried.value,billingClock.value))
const receiptState=computed(()=>error.value?'刷新失败，保留上次数据':busy.value?'正在刷新费用…':'自动刷新 · 页面可见时约 30 秒')
const unassigned=computed(()=>unattributedCostRecords(costs.value,data.value.providers))
const bill=(name:ChannelName)=>official.value.items.find(item=>item.provider===name)
const officialPeriod=(name:ChannelName)=>{const item=bill(name);const period=item||currentBillPeriod(name==='deepseek'?'Asia/Shanghai':'UTC',billingClock.value);return `${period.from} 至 ${period.to}`}
const officialAmount=(name:ChannelName)=>{const item=bill(name);return item?formatOfficialAmount(item):props.officialAccess?'待同步官方账单':'无官方账单权限'}
const channelNames:ChannelName[]=['deepseek','openai']
const channelName=(name:ChannelName)=>name==='deepseek'?'DeepSeek':'OpenAI'
const channel=(name:ChannelName)=>adminTranslationChannel(data.value,name,Boolean(error.value))
const providerCosts=(name:ChannelName)=>providerReceipt(data.value,name)
const amount=(row:Row|null|undefined)=>{const value=receiptCost(row).amount;return value===null?(busy.value?'读取中…':'尚未取得'):usd(value)}
const receiptLabel=(row:Row|null|undefined)=>receiptCost(row).partial?'已知费用 · 记录待补齐':'实时核算费用'
const pending=(row:Row|null|undefined)=>{const count=costRecordCount(row?.unpriced_requests);return count?fmt(count)+' 条费用记录不完整':''}
const characters=computed(()=>{
 const value=(data.value.totals as Row|undefined)?.charged_characters
 if(value===null||value===undefined||value==='')return null
 const amount=typeof value==='number'?value:typeof value==='string'&&/^\d+$/.test(value)?Number(value):NaN
 return Number.isSafeInteger(amount)&&amount>=0?amount:null
})
let revision=0,balanceRevision=0,disposed=false,again=false,inFlight:Promise<void>|undefined
const readPolling=new ReadPolling(30000),balancePolling=new ReadPolling(30000)
const denied=(e:unknown)=>Boolean(e&&typeof e==='object'&&'code' in e&&['unauthorized','admin_forbidden'].includes(String(e.code)))
function clearBalance(){++balanceRevision;balance.value=null;balanceError.value='';balanceBusy.value=false;balancePolling.reset()}
async function readBalance(force=true){
 if(disposed||!props.canReadCosts||!props.officialAccess||!deepseekEnabled.value||localPreview||balanceBusy.value||(!force&&(!balancePolling.due()||document.visibilityState!=='visible')))return
 const version=++balanceRevision,identity=props.identity,startedAt=Date.now();balanceBusy.value=true;balanceError.value=''
 try{const result=parseProviderBalance(await request<unknown>('provider-balance'));if(!disposed&&version===balanceRevision&&identity===props.identity&&props.officialAccess){balance.value=result;balanceReadAt.value=Date.now();balancePolling.succeeded(startedAt)}}
 catch(e){if(!disposed&&version===balanceRevision&&identity===props.identity){balancePolling.failed();if(denied(e))balance.value=null;balanceError.value=e instanceof Error?e.message:'暂时无法读取资金。'}}
 finally{if(!disposed&&version===balanceRevision){balanceBusy.value=false;clock.value=Date.now()}}
}
function matchesPeriod(value:Row,period:typeof queried.value){
 if(!value||typeof value!=='object'||Array.isArray(value))return false
 return value.timezone==='UTC'&&Date.parse(String(value.from))===Date.parse(period.from+'T00:00:00Z')
  &&Date.parse(String(value.toExclusive))===Date.parse(period.to+'T00:00:00Z')+86400000
  &&Number.isFinite(Date.parse(String(value.snapshotAt)))
}
async function refresh(force=true):Promise<void>{
 clock.value=Date.now()
 if(disposed||!props.canReadCosts)return
 void readBalance(false)
 if(inFlight){if(force)again=true;return inFlight}
 if(!force&&(!readPolling.due()||document.visibilityState!=='visible'))return
 const version=++revision,identity=props.identity,startedAt=Date.now()
 const selected={...currentBillPeriod('UTC'),timezone:'UTC',provider:'',officialCurrentMonth:'true'}
 busy.value=true
 const work=(async()=>{
  try{
   const result=await request<Row>('costs?'+new URLSearchParams(selected))
   if(disposed||version!==revision||identity!==props.identity||!props.canReadCosts)return
   if(!matchesPeriod(result,selected))throw new Error('账期数据尚未核实，请稍后刷新。')
   data.value=props.officialAccess?result:{...result,officialBills:[]}
   queried.value=selected;clock.value=Date.now();costsReadAt.value=clock.value;error.value='';readPolling.succeeded(startedAt)
   if(!deepseekEnabled.value)clearBalance()
  }catch(e){
   if(!disposed&&version===revision&&identity===props.identity){
    readPolling.failed();if(denied(e)){data.value={};clearBalance()}
    error.value=e instanceof Error?e.message:'暂时无法读取本月数据。'
   }
  }finally{if(!disposed&&version===revision)busy.value=false}
 })()
 inFlight=work
 try{await work}
 finally{
  if(inFlight===work){
   inFlight=undefined
   if(again&&!disposed&&props.canReadCosts){again=false;await refresh()}
  }
 }
}
watch(()=>[props.identity,props.canReadCosts,props.officialAccess],()=>{
 ++revision;inFlight=undefined;again=false;data.value={};error.value='';busy.value=false;readPolling.reset()
 clearBalance()
 queried.value={...currentBillPeriod('UTC'),timezone:'UTC',provider:'',officialCurrentMonth:'true'}
 void refresh()
},{flush:'sync'})
onMounted(()=>void refresh())
onUnmounted(()=>{disposed=true;++revision;++balanceRevision;again=false;inFlight=undefined})
defineExpose({refresh})
</script>

<template>
 <article v-if="canReadCosts" class="adm-overview-characters" :aria-busy="busy">
  <span>本月已用字符</span><strong>{{characters===null?(busy?'读取中…':'尚未取得'):fmt(characters)}}</strong>
  <small>本月 UTC · 全部通道</small>
  <p v-if="error" class="adm-overview-delayed" role="status">{{characters===null?'本月数据读取失败，未显示为零。':'读取失败，保留上次数据；当前显示可能过期。'}} {{error}}</p>
 </article>
 <section v-if="canReadCosts" class="adm-overview-billing" aria-label="本月 API 费用" :aria-busy="busy">
  <header class="adm-overview-billing-heading"><div><h2>本月官方账单 <small>USD</small></h2><p>当前服务商账号 · 各通道当地账期</p></div><a href="/admin/costs">账单与同步 →</a></header>
  <p class="adm-cost-freshness" role="status">{{receiptState}}<span v-if="data.snapshotAt"> · 数据更新于 {{utcTimestamp(data.snapshotAt)}}</span></p>
  <div class="adm-overview-cost-grid">
   <article v-for="name in channelNames" :key="name" class="adm-overview-provider" :data-provider="name">
    <span>{{channelName(name)}}</span><strong class="adm-live-amount adm-official-amount" :title="bill(name)?.amount" :class="{'is-pending':!bill(name)}">{{officialAmount(name)}}</strong>
    <small v-if="officialAccess" class="adm-bill-status">{{officialBillStatus(bill(name),queried,billingClock)}}</small>
    <small class="adm-bill-period">{{officialPeriod(name)}} · {{name==='deepseek'?'GMT+8':'UTC'}}</small>
    <small v-if="bill(name)" class="adm-bill-updated">{{bill(name)?.source==='manual_statement'?'官方账单手动导入于':'官方账单自动采集于'}} {{utcTimestamp(bill(name)?.fetchedAt)}}</small>
    <small v-if="bill(name)" class="adm-bill-notice">{{officialBillNotice(bill(name),queried,billingClock)}}</small>
    <a v-else-if="officialAccess&&name==='openai'" class="adm-bill-link" href="/admin/costs">检查官方账单连接 →</a>
    <small v-if="channel(name).model" class="adm-overview-model">{{channel(name).model}}</small>
    <small v-if="channel(name).status!=='已开放选择'" class="adm-overview-channel-state">{{channel(name).status}}</small>
   </article>
   <article class="adm-overview-cost"><span>官方账单合计</span><strong class="adm-live-amount adm-official-amount" :class="{'is-pending':!official.complete}" :title="official.total??undefined">{{official.complete?usd(official.total):officialAccess?'账单未齐全':'无官方账单权限'}}</strong><small v-if="officialAccess&&!official.complete" class="adm-bill-notice">待同步 {{official.missing.map(channelName).join('、')}}；已取得的金额见对应通道。</small><small v-if="official.complete">DeepSeek + OpenAI · 已取得的官方快照</small><small v-if="official.complete&&officialDelayed" class="adm-bill-status">部分账单待更新，合计并非当前实时费用</small></article>
  </div>
  <p v-if="officialDelayed" class="adm-overview-delayed" role="status">官方账单同步有延迟，当前保留上次账期金额。</p>
  <p v-if="error" class="adm-overview-delayed" role="status">{{costs?'读取失败，保留上次费用；当前显示可能过期。':'费用尚未取得，未显示为零。'}}</p>
  <details class="adm-overview-billing-details"><summary>核算说明<span v-if="officialAccess&&deepseekEnabled">与账户资金</span></summary>
   <p>主金额只使用当前账号的官方账单，不使用回执估算或余额差补齐。来源、账期与采集时间见各通道；同一账号、筛选条件和快照时间下与官方原始金额一致。</p>
   <div class="adm-receipt-details"><p>回执核算 · {{queried.from}} 至 {{queried.to}} · UTC · 含历史账号</p><p v-for="name in channelNames" :key="name">{{channelName(name)}}：{{amount(providerCosts(name))}} · {{receiptLabel(providerCosts(name))}}<span v-if="pending(providerCosts(name))"> · {{pending(providerCosts(name))}}</span></p><p>回执合计：{{amount(costs)}}<span v-if="pending(costs)"> · {{pending(costs)}}</span></p><p v-if="unassigned">含 {{fmt(unassigned)}} 条历史记录尚未归属通道</p><p>回执费用仅用于排查，不替代官方账单；费用记录不完整不表示翻译正在排队。</p></div>
   <p>官方账单来自当前账号，分别按 DeepSeek GMT+8、OpenAI UTC 的当前月份核对；跨午夜或跨月时两项日期可能不同，具体日期见各通道。缺失账单不会用余额变化或历史回执补齐。</p>
   <p>DeepSeek 官方单项金额按官网截断为两位小数；悬停金额可查看原始精度。合计使用原始金额相加后四舍五入，可能与页面两项相加略有差异。</p>
   <p>页面定时重读已保存的账单；DeepSeek 官方账单须重新导入后更新。</p>
   <p v-for="item in official.items" :key="item.provider">{{channelName(item.provider)}} 账单{{item.source==='manual_statement'?'录入于':'采集于'}} {{utcTimestamp(item.fetchedAt)}}{{item.provisional?' · 近期费用仍可能补记':''}}</p>
   <p v-if="data.snapshotAt">页面读取于 {{utcTimestamp(data.snapshotAt)}}</p>
   <ProviderFundingCard v-if="officialAccess&&deepseekEnabled" class="adm-overview-funding" compact :balance="balance" :error="balanceError" :busy="balanceBusy" :now="balanceClock" :local-preview="localPreview" @refresh="readBalance()" />
  </details>
 </section>
</template>
<style scoped>
.adm-bill-status{margin-top:6px;color:var(--muted);line-height:1.7}.adm-bill-period{margin-top:6px;line-height:1.7}.adm-receipt-details{padding-top:10px;border-top:1px solid var(--line)}
.adm-overview-cost-grid .adm-live-amount.is-pending{font-size:19px;line-height:1.6;letter-spacing:0}.adm-receipt-amount{margin-top:6px}.adm-bill-updated{font-size:11px;line-height:1.6;margin-top:6px;color:var(--muted)}
.adm-cost-freshness{font-size:12px;line-height:1.7;color:var(--muted);margin:0 0 12px!important}.adm-official-comparison{font-size:12px;line-height:1.7;border-top:1px solid var(--line);padding-top:12px;margin-top:12px!important}.adm-official-comparison b{font-variant-numeric:tabular-nums;font-weight:600}.adm-bill-notice,.adm-bill-link{font-size:11px;line-height:1.7;color:var(--muted);margin-top:5px;display:block}.adm-bill-link{color:var(--green)}
.adm-overview-billing{grid-column:1/-1;min-width:0;margin-top:8px}.adm-overview-billing-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:14px}.adm-overview-billing-heading h2{font-size:18px;margin:0;font-weight:600}.adm-overview-billing-heading h2 small{font-size:12px;margin-left:6px;font-weight:400}.adm-overview-billing-heading p{font-size:12px;color:var(--muted);margin-top:4px}.adm-overview-billing-heading a{font-size:13px;white-space:nowrap;color:var(--green)}.adm-overview-cost-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:15px}.adm-overview-cost-grid strong{font-size:32px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;letter-spacing:-.5px}.adm-overview-cost-grid .adm-overview-cost{background:#eef5f0;border-color:#c9ded1}.adm-overview-cost-grid small{display:block;font-size:12px;overflow-wrap:anywhere}.adm-overview-model{margin-top:5px}.adm-overview-channel-state{margin-top:5px}.adm-overview-delayed{font-size:12px;line-height:1.7;color:#966119;overflow-wrap:anywhere;margin-top:8px!important}.adm-overview-billing-details{margin-top:14px;font-size:12px;color:var(--muted)}.adm-overview-billing-details summary{cursor:pointer;display:list-item}.adm-overview-billing-details summary span{display:inline;font:inherit;color:inherit}.adm-overview-billing-details>p{margin:10px 0;line-height:1.7}.adm-overview-billing-details .adm-overview-funding{margin-top:14px;max-width:660px}@media(max-width:700px){.adm-overview-cost-grid{grid-template-columns:1fr;gap:10px}.adm-overview-billing-heading{align-items:flex-start}.adm-overview-cost-grid strong{font-size:30px}}
</style>
