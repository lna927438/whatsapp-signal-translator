<script setup lang="ts">
import {computed,onMounted,onUnmounted,ref,watch} from 'vue'
import AdminTable,{type Column} from './AdminTable.vue'
import {request,fmt,tokens,usd,localPreview,type Row} from './client'
import {parseProviderBalance,balanceState,utcTimestamp,type ProviderBalance} from './providerBalance'
import {currentBillPeriod,officialBillSummary,officialBillDelayed,officialBillNotice,officialBillStatus,officialBillReadIssue,enabledBillProviders,selectedBillProviders} from './officialBills'
import ProviderFundingCard from './ProviderFundingCard.vue'
import {ReadPolling} from './readPolling'
import {adminTranslationChannel,type ChannelName} from './translationChannels'
import {officialCostCards,costRecordCount,unattributedCostRecords,officialAmount,providerReceipt,receiptCost} from './costCards'
const props=defineProps<{officialAccess:boolean}>()
const emit=defineEmits<{reconcile:[data:Row];funding:[data:Row]}>()
const to=ref(new Date().toISOString().slice(0,10)),from=ref(to.value.slice(0,8)+'01'),provider=ref(''),timezone=ref('UTC')
const followCurrentPeriod=ref(true)
const queriedFollowCurrentPeriod=ref(true)
const data=ref<Row>({}),busy=ref(false),error=ref(''),syncBusy=ref(false),syncInfo=ref<Row>({}),syncMessage=ref('')
const detailData=ref<Row|null>(null),detailBusy=ref(false),detailError=ref(''),detailsOpen=ref(false)
let detailRevision=0,detailRequested=false
const syncFailure=ref<{from:string;to:string;after:number}|null>(null)
const queried=ref({from:from.value,to:to.value,provider:provider.value,timezone:timezone.value,officialCurrentMonth:''})
const balance=ref<ProviderBalance|null>(null),balanceError=ref(''),balanceBusy=ref(false),clock=ref(Date.now())
const balanceReadAt=ref(Date.now()),balanceClock=computed(()=>balance.value?Date.parse(balance.value.checkedAt)+Math.max(0,clock.value-balanceReadAt.value):clock.value)
const costsReadAt=ref(Date.now())
const billingClock=computed(()=>{const snapshot=Date.parse(String(data.value.snapshotAt||''));return Number.isFinite(snapshot)?snapshot+Math.max(0,clock.value-costsReadAt.value):clock.value})
const totals=computed(()=>data.value.totals as Row||{}),detailTotals=computed(()=>detailData.value?.totals as Row||{})
const characters=computed(()=>costRecordCount(totals.value.charged_characters))
const users=computed(()=>detailData.value?.users as Row[]||[]),days=computed(()=>detailData.value?.days as Row[]||[])
const providers=computed(()=>detailData.value?.providers as Row[]||[])
const enabledProviders=computed(()=>{
  const available=enabledBillProviders(Object.hasOwn(data.value,'enabledProviders')?data.value:syncInfo.value)
  return Object.hasOwn(syncInfo.value,'enabledProviders')?available.filter(name=>enabledBillProviders(syncInfo.value).includes(name)):available
})
const officialProviders=computed(()=>selectedBillProviders({enabledProviders:enabledProviders.value},queried.value))
const retiredProvider=computed(()=>Boolean(queried.value.provider&&!enabledProviders.value.includes(queried.value.provider as 'openai'|'deepseek')))
const officialZones=computed(()=>officialProviders.value.map(name=>name==='openai'?'OpenAI UTC':'DeepSeek GMT+8').join(' · '))
const openaiEnabled=computed(()=>enabledProviders.value.includes('openai'))
const official=computed(()=>officialBillSummary(props.officialAccess?{...data.value,enabledProviders:enabledProviders.value}:{},queried.value,clock.value))
const officialCards=computed(()=>officialCostCards(props.officialAccess?{...data.value,enabledProviders:enabledProviders.value}:{},queried.value,clock.value))
const unassigned=computed(()=>unattributedCostRecords(detailTotals.value,detailData.value?.providers))
const officialDelayed=computed(()=>officialBillDelayed(official.value,queried.value,billingClock.value))
const billingIssue=computed(()=>{if(!openaiEnabled.value)return '';const state=syncInfo.value.sync as Row|undefined;return state?.status==='error'?String(state.message||'OpenAI 官方账单暂时无法同步，保留上次金额。'):''})
const openaiConnection=computed(()=>!props.officialAccess||!openaiEnabled.value?'':billingIssue.value||String(syncInfo.value.statusReadError||'')||(syncInfo.value.configured===false?'官方账单未接通，请由主管理员配置账单读取凭据。':''))
const receiptState=computed(()=>error.value?'读取失败，保留上次记录':busy.value?'正在读取已保存记录…':'约每 30 秒重读已保存记录；手工金额不会自动更新')
const incomplete=computed(()=>(costRecordCount(detailTotals.value.unpriced_requests)||0)>0)
const known=(row:Row)=>row.known_cost_usd_exact??row.known_cost_usd??row.cost_usd
const bill=(name:string)=>official.value.items.find(b=>b.provider===name)
const billReadIssue=(name:string)=>props.officialAccess?officialBillReadIssue(data.value,name):''
const billPeriod=(name:string)=>bill(name)??(queried.value.officialCurrentMonth==='true'?currentBillPeriod(name==='deepseek'?'Asia/Shanghai':'UTC',billingClock.value):queried.value)
const providerName=(name:string)=>name==='openai'?'OpenAI':'DeepSeek'
const channel=(name:string)=>adminTranslationChannel(data.value,name as ChannelName,Boolean(error.value))
const local=(name:string)=>providers.value.find(b=>b.provider===name)
const receipt=(name:string)=>providerReceipt(detailData.value??{},name as ChannelName)
const receiptLabel=(row:Row|null|undefined)=>receiptCost(row).partial?'已知费用 · 记录待补齐':'实时核算费用'
const selected=(name:string)=>!queried.value.provider||queried.value.provider===name
function providerAmount(name:string){
  if(!selected(name))return '未纳入筛选'
  if(!props.officialAccess)return '无官方账单权限'
  if(billReadIssue(name))return '账单暂未取得'
  const item=bill(name)
  return item?officialAmount(item):'待同步官方账单'
}
function receiptAmount(name:string){
  if(!selected(name))return '未纳入筛选'
  if(!detailData.value?.totals)return detailBusy.value?'读取中…':'尚未取得'
  if(!Array.isArray(detailData.value.providers))return '尚未取得'
  const value=receiptCost(receipt(name)).amount
  return value===null?'尚未取得':usd(value)
}
const columns:Column[]=[{key:'email',title:'用户'},{key:'charged_characters',title:'已扣字符',format:r=>fmt(r.charged_characters)},
  {key:'known_cost_usd',title:'按回执核算 · USD',format:r=>usd(known(r))},{key:'unpriced_requests',title:'费用记录不完整',format:r=>fmt(r.unpriced_requests)}]
const dayColumns:Column[]=[{key:'day',title:'日期'},...columns.filter(c=>c.key!=='email')]
let timer:ReturnType<typeof setInterval>|undefined,balanceTimer:ReturnType<typeof setInterval>|undefined,revision=0,balanceRevision=0,disposed=false,statusAt=0,refreshAfterLoad=false,accessRevision=0,statusRevision=0
const readPolling=new ReadPolling(30000),balancePolling=new ReadPolling(30000)
const periodKey=(period:typeof queried.value)=>JSON.stringify([period.from,period.to,period.timezone,period.provider])
function clearDetails(){++detailRevision;detailData.value=null;detailError.value='';detailBusy.value=false;detailRequested=false}
async function readDetails(force=false){
  if(disposed||!detailsOpen.value||detailBusy.value||!data.value.totals||(!force&&detailRequested))return
  const version=++detailRevision,accessVersion=accessRevision,period={...queried.value},key=periodKey(period)
  detailBusy.value=true;detailRequested=true;detailError.value=''
  const params=new URLSearchParams(period);params.delete('officialCurrentMonth')
  try{
    const result=await request<Row>('costs?'+params)
    if(!disposed&&version===detailRevision&&accessVersion===accessRevision&&key===periodKey(queried.value))detailData.value=result
  }catch(e){
    if(!disposed&&version===detailRevision&&accessVersion===accessRevision){
      detailError.value=e instanceof Error?e.message:'暂时无法读取核算明细。'
      if(e&&typeof e==='object'&&'code' in e&&['unauthorized','admin_forbidden'].includes(String(e.code))){detailData.value=null;data.value={};++revision;busy.value=false;refreshAfterLoad=false;++balanceRevision;balance.value=null;balanceError.value='';balanceBusy.value=false;++statusRevision;syncInfo.value={}}
    }
  }finally{if(!disposed&&version===detailRevision)detailBusy.value=false}
}
function toggleDetails(event:Event){detailsOpen.value=(event.currentTarget as HTMLDetailsElement).open;if(detailsOpen.value)void readDetails()}
async function load(applyFilters=false,automatic=false){if(disposed)return;if(busy.value){if(!automatic)refreshAfterLoad=true;return}if(automatic&&(!readPolling.due()||document.visibilityState!=='visible'))return;const version=++revision,accessVersion=accessRevision,startedAt=Date.now();busy.value=true;try{
  const selected=applyFilters?{from:from.value,to:to.value,provider:provider.value,timezone:timezone.value,officialCurrentMonth:''}:{...queried.value}
  // Unsubmitted form edits must not change the displayed bill's period or basis.
  const followSelectedPeriod=applyFilters?followCurrentPeriod.value:queriedFollowCurrentPeriod.value
  if(followSelectedPeriod){
    Object.assign(selected,currentBillPeriod(selected.timezone))
    if(applyFilters||(followCurrentPeriod.value&&from.value===queried.value.from&&to.value===queried.value.to)){from.value=selected.from;to.value=selected.to}
  }
  selected.officialCurrentMonth=followSelectedPeriod&&selected.timezone==='UTC'&&!selected.provider?'true':''
  const params=new URLSearchParams(selected);if(!selected.officialCurrentMonth)params.delete('officialCurrentMonth')
  const result=await request<Row>('billing-summary?'+params);if(version===revision){if(periodKey(selected)!==periodKey(queried.value))clearDetails();data.value=props.officialAccess&&accessVersion===accessRevision?result:{...result,officialBills:[]};costsReadAt.value=Date.now();queried.value=selected;queriedFollowCurrentPeriod.value=followSelectedPeriod;error.value='';readPolling.succeeded(startedAt);if(detailsOpen.value)void readDetails()}
}catch(e){if(version===revision){readPolling.failed();if(e&&typeof e==='object'&&'code' in e&&['unauthorized','admin_forbidden'].includes(String(e.code))){data.value={};clearDetails();++balanceRevision;balance.value=null;balanceError.value='';balanceBusy.value=false;++statusRevision;syncInfo.value={}}error.value=e instanceof Error?e.message:'暂时无法读取。'}}finally{if(version===revision){busy.value=false;if(refreshAfterLoad&&!disposed){refreshAfterLoad=false;void load()}}}}
async function readSyncStatus(force=false){if(localPreview||!props.officialAccess||disposed||(!force&&Date.now()-statusAt<60000))return;statusAt=Date.now();const version=++statusRevision,accessVersion=accessRevision;try{const value=await request<Row>('billing-status');if(!disposed&&props.officialAccess&&version===statusRevision&&accessVersion===accessRevision)syncInfo.value=value}catch{if(!disposed&&props.officialAccess&&version===statusRevision&&accessVersion===accessRevision)syncInfo.value={...syncInfo.value,statusReadError:'暂时无法读取官方账单连接状态，保留上次结果。'}}}
async function sync(){if(syncBusy.value||!props.officialAccess||disposed||!openaiEnabled.value)return;const accessVersion=accessRevision,period={from:queried.value.from,to:queried.value.to};syncBusy.value=true;syncMessage.value='';syncFailure.value=null;try{
  const result=await request<Row>('billing-sync',period);if(!disposed&&props.officialAccess&&accessVersion===accessRevision){syncMessage.value=String(result.message||'官方账单已同步。');await load()}
}catch(e){if(!disposed&&props.officialAccess&&accessVersion===accessRevision){syncMessage.value=e instanceof Error?e.message:'同步未完成，已保留上次结果。';syncFailure.value={...period,after:billingClock.value}}}finally{if(!disposed&&props.officialAccess&&accessVersion===accessRevision){syncBusy.value=false;void readSyncStatus(true)}}}
async function readBalance(automatic=false){if(balanceBusy.value||localPreview||!props.officialAccess||disposed||(automatic&&(!balancePolling.due()||document.visibilityState!=='visible')))return;const version=++balanceRevision,startedAt=Date.now();balanceBusy.value=true;balanceError.value='';try{
  // Use only this account-scoped endpoint. A historical cost summary may carry
  // a balance from an older provider account and must never fill a missing value.
  const result=parseProviderBalance(await request<unknown>('provider-balance'));if(version===balanceRevision&&!disposed&&props.officialAccess){balance.value=result;balanceReadAt.value=Date.now();balancePolling.succeeded(startedAt)}
}catch(e){if(version===balanceRevision&&!disposed){balancePolling.failed();if(e&&typeof e==='object'&&'code' in e&&['unauthorized','admin_forbidden'].includes(String(e.code)))balance.value=null;balanceError.value=e instanceof Error?e.message:'无法查询余额。'}}finally{if(version===balanceRevision&&!disposed){balanceBusy.value=false;clock.value=Date.now()}}}
function reconcile(name:string){if(enabledProviders.value.includes(name as 'openai'|'deepseek')){const period=billPeriod(name);emit('reconcile',{provider:name,from:period.from,to:period.to,timezone:name==='deepseek'?'Asia/Shanghai':'UTC'})}}
function confirmFunding(){if(!props.officialAccess||balanceBusy.value||!balance.value?.fetchedAt||balanceState(balance.value,balanceError.value,balanceClock.value).delayed||!balance.value.balances.some(row=>row.currency==='USD'))return;emit('funding',{currency:'USD',cumulativeTopUps:balance.value.funding?.cumulativeTopUps??'',cumulativeCashRefunds:balance.value.funding?.cumulativeCashRefunds??'0',balanceFetchedAt:balance.value.fetchedAt,reference:''})}
function resume(){clock.value=Date.now();if(document.visibilityState==='visible'){void load(false,true);void readBalance(true);void readSyncStatus()}}
watch([official,syncFailure],()=>{const failure=syncFailure.value,bill=official.value.items.find(item=>item.provider==='openai'&&item.source==='openai_costs_api');if(failure&&bill&&queried.value.from===failure.from&&queried.value.to===failure.to&&Date.parse(bill.fetchedAt)>failure.after){syncFailure.value=null;syncMessage.value='OpenAI 官方账单已恢复同步。';void readSyncStatus(true)}})
watch(()=>props.officialAccess,value=>{++balanceRevision;++accessRevision;++statusRevision;clearDetails();readPolling.reset();balancePolling.reset();data.value={...data.value,officialBills:[]};balance.value=null;balanceError.value='';balanceBusy.value=false;syncBusy.value=false;syncMessage.value='';syncFailure.value=null;syncInfo.value={};statusAt=0;if(value){void load();void readBalance();void readSyncStatus()}})
onMounted(()=>{void load(true);void readSyncStatus();void readBalance();timer=setInterval(()=>{clock.value=Date.now();if(document.visibilityState==='visible')void load(false,true)},30000);balanceTimer=setInterval(()=>{if(document.visibilityState==='visible'){void readBalance(true);void readSyncStatus()}},30000);document.addEventListener('visibilitychange',resume);window.addEventListener('online',resume)})
onUnmounted(()=>{disposed=true;++revision;++balanceRevision;++detailRevision;clearInterval(timer);clearInterval(balanceTimer);document.removeEventListener('visibilitychange',resume);window.removeEventListener('online',resume)})
defineExpose({refreshFunding:readBalance,refreshCosts:load})
</script>
<template><div class="adm-costs">
  <section v-if="officialAccess&&enabledProviders.includes('deepseek')" class="adm-card adm-account-funding" aria-label="DeepSeek 自动累计充值消耗">
    <ProviderFundingCard :balance="balance" :error="balanceError" :busy="balanceBusy" :now="balanceClock" :local-preview="localPreview" @refresh="readBalance" @confirm="confirmFunding" />
  </section>
  <header class="adm-statement-heading"><h2>账期账单记录</h2><p>按下方账期查询已保存记录，与上方累计充值消耗分开核对。</p></header>
  <form class="adm-toolbar adm-card" @submit.prevent="load(true)"><label>开始日期<input v-model="from" type="date" required :disabled="busy||syncBusy" @input="followCurrentPeriod=false" /></label><label>结束日期<input v-model="to" type="date" required :min="from" :disabled="busy||syncBusy" @input="followCurrentPeriod=false" /></label>
    <label>业务统计时区<select v-model="timezone" :disabled="busy||syncBusy"><option value="UTC">UTC</option><option value="Asia/Shanghai">GMT+8</option></select></label>
    <label>翻译通道<select v-model="provider" :disabled="busy||syncBusy"><option value="">全部</option><option value="openai">{{openaiEnabled?'OpenAI':'OpenAI（历史）'}}</option><option value="deepseek">DeepSeek</option></select></label>
    <button class="adm-primary" :disabled="busy">{{busy?'读取中…':'查询'}}</button></form>
  <p v-if="error" class="adm-error" role="alert">{{error}} 下方保留上次结果。</p>
  <p class="adm-help adm-query-period">{{queried.from}} 至 {{queried.to}} · {{queried.timezone==='UTC'?'UTC':'GMT+8'}} · {{queried.provider?providerName(queried.provider):'全部通道'}}<span v-if="queriedFollowCurrentPeriod"> · 本月</span></p>
  <p class="adm-cost-freshness" role="status">{{receiptState}}<span v-if="data.snapshotAt"> · 页面读取于 {{utcTimestamp(data.snapshotAt)}}</span></p>
  <section class="adm-provider-costs" aria-label="通道用量与费用">
    <div class="adm-provider-cost-grid">
      <article v-for="name in ['deepseek','openai']" :key="name" class="adm-provider-cost-card" :class="{'is-excluded':!selected(name)}" :data-provider="name">
        <header><h2>{{providerName(name)}}</h2><span class="adm-channel-status" :class="{available:channel(name).available}">{{channel(name).status}}{{channel(name).isDefault?' · 默认':''}}</span></header>
        <p class="adm-fee-label">当前账号账期记录 · USD</p>
        <strong class="adm-provider-amount adm-official-amount" :title="bill(name)?.amount" :class="{'is-pending':!selected(name)||!bill(name)}">{{providerAmount(name)}}</strong>
        <p v-if="selected(name)&&officialAccess" class="adm-bill-status" role="status">{{billReadIssue(name)||officialBillStatus(bill(name),queried,billingClock)}}</p>
        <small class="adm-bill-period">{{billPeriod(name).from}} 至 {{billPeriod(name).to}} · {{name==='deepseek'?'GMT+8':'UTC'}}</small>
        <small v-if="bill(name)" class="adm-bill-updated">{{bill(name)?.source==='manual_statement'?'手工录入于':'官方 API 采集于'}} {{utcTimestamp(bill(name)?.fetchedAt)}}</small>
        <small v-if="bill(name)" class="adm-bill-notice">{{officialBillNotice(bill(name),queried,billingClock)}}</small>
        <small v-if="selected(name)&&name==='openai'&&openaiConnection" class="adm-bill-notice" role="status">{{openaiConnection}}</small>
        <small v-else-if="selected(name)&&officialAccess&&!bill(name)&&!billReadIssue(name)" class="adm-bill-notice">{{name==='deepseek'?'请核对并录入所选账期金额。':'请在下方账期记录明细中同步或检查连接。'}}</small>
        <p class="adm-provider-model">当前模型 <b>{{channel(name).model||'尚未取得'}}</b></p>
      </article>
      <article class="adm-provider-cost-card adm-total-cost" data-provider="total">
        <header><h2>合计</h2><span class="adm-total-scope">全部通道</span></header>
        <p class="adm-fee-label">已保存账期记录合计 · USD</p>
        <strong class="adm-provider-amount adm-official-amount" :title="officialCards.total??undefined" :class="{'is-pending':Boolean(queried.provider)||!officialCards.complete}">{{queried.provider?'请选全部通道查看合计':!officialAccess?'无官方账单权限':officialCards.complete?usd(officialCards.total):'账单未齐全'}}</strong>
        <small v-if="officialCards.complete&&!queried.provider" class="adm-bill-notice">合计按原始金额计算，显示取两位小数。</small>
        <small v-if="officialAccess&&!queried.provider&&!officialCards.complete" class="adm-bill-notice">待同步 {{officialCards.missing.map(providerName).join('、')}}；已取得的金额见对应通道。</small>
        <small v-if="officialCards.complete" class="adm-bill-notice">DeepSeek + OpenAI · 仅合计上述账期记录，不含累计充值消耗</small>
        <small v-if="officialCards.complete&&officialDelayed" class="adm-bill-status">部分账单待更新，合计并非当前实时费用</small>
        <p class="adm-character-total">已用字符 <b>{{characters===null?'尚未取得':fmt(characters)}}</b><small v-if="Number(totals.refunded_characters)>0">已补偿 {{fmt(totals.refunded_characters)}} 字符</small></p>
      </article>
    </div>
    <p class="adm-help">本组金额为当前账号已保存的账期记录，来源与记录时间分别标注。手工录入不代表已通过官方接口核实；OpenAI 官方 API 数据可能延迟补记。累计充值消耗、余额与回执核算均不计入本组合计。</p>
  </section>
  <section v-if="officialAccess&&retiredProvider" class="adm-card adm-retired-provider"><h2>{{providerName(queried.provider)}} 历史用量</h2><p>此通道已停用。历史调用回执仍可查账，不计入当前启用通道的官方账单，也不再同步或录入该通道的当前账号账单。</p></section>
  <details v-if="officialAccess&&officialProviders.length" class="adm-card adm-official-breakdown"><summary>账期记录明细 <span>{{billingIssue?'同步异常':official.complete?usd(official.total):'尚未齐全'}}</span></summary><p class="adm-help">{{queried.officialCurrentMonth==='true'?'分别按各通道当地本月':'按所选日历日期'}}汇总当前启用通道的账号账单：{{officialZones}}<span v-if="officialProviders.length>1">，实际时间边界不同</span>。未取得启用通道账单时，只显示已同步部分。余额变化包含充值、赠金和其他调用，不用于补齐账期费用。</p>
    <p class="adm-official-total">已保存账期记录合计：<b>{{official.complete?usd(official.total):'尚未齐全'}}</b><small v-if="!official.complete"> · 待同步 {{official.missing.map(providerName).join('、')}}；已取得的金额见对应通道。</small></p>
    <div v-for="name in officialProviders" :key="name" class="adm-bill-provider">
      <div><h3>{{providerName(name)}}</h3>
        <small>{{billPeriod(name).from}} 至 {{billPeriod(name).to}} · {{name==='openai'?'UTC':'GMT+8'}}</small>
        <p>已保存账期金额：<b :title="bill(name)?.amount">{{bill(name)?officialAmount(bill(name)!):'尚未同步该账期'}}</b></p>
        <small v-if="bill(name)">{{bill(name)?.source==='manual_statement'?'手工录入':'官方 Costs API 快照'}} · {{bill(name)?.source==='manual_statement'?'录入于':'采集于'}} {{utcTimestamp(bill(name)?.fetchedAt)}}<br />{{bill(name)?.provisional?'近期费用仍可能补记':'按该次账单记录'}}</small>
        <small v-if="bill(name)" class="adm-bill-notice">{{officialBillNotice(bill(name),queried,billingClock)}}</small>
      </div>
      <div class="adm-bill-actions"><button v-if="name==='openai'" class="adm-primary" :disabled="busy||syncBusy||!syncInfo.configured||localPreview" @click="sync">{{syncBusy?'同步中…':'同步官方账单'}}</button><button class="adm-button" :disabled="busy||syncBusy" @click="reconcile(name)">录入账单核对</button></div>
    </div>
    <p v-if="openaiEnabled&&syncInfo.statusReadError" class="adm-help" role="status">{{syncInfo.statusReadError}}</p>
    <p v-if="billingIssue&&queried.provider!=='deepseek'" class="adm-error" role="alert">{{billingIssue}}</p>
    <p v-if="officialDelayed" class="adm-help" role="status">部分账期记录待更新，当前保留上次金额。</p>
    <p class="adm-help">DeepSeek 金额截断为两位小数；悬停金额可查看原始精度。合计使用原始金额相加后四舍五入，可能与页面两项相加略有差异。</p>
    <p v-if="syncFailure" class="adm-help" role="status">同步未完成，已保留上次结果。</p>
    <p v-if="openaiEnabled&&!syncInfo.configured&&!syncInfo.statusReadError" class="adm-help">{{syncInfo.message||'官方账单同步尚未配置。'}}</p>
    <p class="adm-help">更换过服务商账号时，旧账号费用需另行核对。DeepSeek 官方接口可查询余额；手工账期记录需另行与官方账单核对，余额变化不会当作所选账期翻译成本。</p><p v-if="openaiEnabled&&syncMessage" class="adm-help" role="status">{{syncMessage}}</p>
  </details>
  <details class="adm-card adm-usage-details" @toggle="toggleDetails"><summary>用量与核算明细 <span>{{detailBusy?'读取中…':detailError?'读取未完成':detailData?'已读取':'展开后读取'}}</span></summary>
    <div class="adm-detail-toolbar"><p class="adm-help">历史回执、按用户统计和每日用量按需读取，不影响上方账单与余额更新。</p><button class="adm-button" :disabled="detailBusy||busy||!data.totals" @click="readDetails(true)">{{detailBusy?'读取中…':'刷新明细'}}</button></div>
    <p v-if="detailError" class="adm-error adm-detail-error" role="alert">核算明细暂时无法读取。{{detailError}} {{detailData?'保留上次明细，当前显示可能过期。':'尚未取得明细，未显示为零。'}}</p>
    <p v-if="!detailData" class="adm-help adm-details-pending" role="status">{{detailBusy?'正在读取核算明细…':detailError?'可稍后点击“刷新明细”重试。':'明细尚未加载，展开后读取。'}}</p>
    <template v-else>
    <p v-if="detailData.snapshotAt" class="adm-help">明细读取于 {{utcTimestamp(detailData.snapshotAt)}} · 不自动刷新</p>
    <section class="adm-user-cost-details"><h2>按用户统计</h2><p class="adm-help">用户费用按调用回执核算，供用量分析；官方账单不能直接分摊到每个用户。</p><AdminTable v-if="Array.isArray(detailData.users)" :rows="users" :columns="columns" empty="所选期间没有请求。" /><p v-else class="adm-help">用户统计尚未取得。</p></section>
    <section class="adm-local-cost-evidence"><h2>每日用量和核算依据</h2>
    <p>回执用量：{{detailData.totals?tokens(detailTotals.provider_requests)+' 次调用 · '+tokens(detailTotals.total_tokens)+' Tokens':'尚未取得'}} · 含历史服务商账号</p>
    <p>按回执核算 · USD：<b>{{usd(known(detailTotals))}}</b><span v-if="incomplete"> · {{fmt(detailTotals.unpriced_requests)}} 条费用记录不完整</span></p>
    <p v-for="name in (queried.provider?[queried.provider]:['openai','deepseek'])" :key="name">{{providerName(name)}} 回执：{{receiptAmount(name)}} · {{receiptLabel(receipt(name))}}<span v-if="costRecordCount(local(name)?.unpriced_requests)"> · {{fmt(local(name)?.unpriced_requests)}} 条费用记录不完整</span><span v-if="local(name)"> · {{fmt(local(name)?.requests)}} 次调用 · {{tokens(local(name)?.total_tokens)}} Tokens</span></p>
    <p v-if="unassigned">含 {{fmt(unassigned)}} 条历史记录尚未归属通道</p>
    <p class="adm-help">以下金额按调用回执和当时单价计算，作为核算依据，不作为官方扣费金额。金额统一显示两位小数，合计使用原始精度计算。</p><AdminTable v-if="Array.isArray(detailData.days)" :rows="days" :columns="dayColumns" /><p v-else class="adm-help">每日用量尚未取得。</p>
    <p class="adm-help">模型与开放状态来自本次服务器配置；已开放不代表实时连通测试。历史费用保留实际调用时的模型与单价，切换模型不会改写旧账。</p>
    <p v-if="incomplete" class="adm-help">记录不完整原因：{{tokens(detailTotals.missing_receipt_requests)}} 条缺少回执，{{tokens(detailTotals.missing_cache_requests)}} 条缺少缓存明细，{{tokens(detailTotals.missing_price_requests)}} 条缺少当时的计价依据。历史缺失不会用当前价格或零费用补填。</p>
    <p class="adm-help">{{tokens(detailTotals.provider_requests)}} 次通道调用 · 输入 {{tokens(detailTotals.input_tokens)}} Tokens · 输出 {{tokens(detailTotals.output_tokens)}} Tokens。缓存读取、缓存写入和输出分别计价；推理 Tokens 已包含在输出中。失败调用可能产生服务商费用，但不扣用户字符。</p>
    <p class="adm-help">按通道筛选时，字符仅归属实际返回译文的通道。费用包含该通道所有尝试，避免切换后漏记费用。</p>
    <p class="adm-help">API 费用按通道实际调用时间计入账期；字符按翻译请求创建时间归属。跨日重试可能落在不同日期。</p>
    <p><a href="https://developers.openai.com/api/docs/pricing" target="_blank" rel="noopener">OpenAI 官方价格 ↗</a> · <a href="https://api-docs.deepseek.com/quick_start/pricing/" target="_blank" rel="noopener">DeepSeek 官方价格 ↗</a></p>
    </section></template>
  </details>
  <p class="adm-help">页面可见时约每 30 秒更新账单和余额；核算明细仅在展开、变更已查询账期或手动刷新时读取。手工账期金额须重新核对录入后更新。<span v-if="data.snapshotAt">页面读取于 {{utcTimestamp(data.snapshotAt)}}。</span></p>
</div></template>
<style scoped>
.adm-costs .adm-query-period{margin:0!important}
.adm-usage-details summary{cursor:pointer;display:list-item}.adm-usage-details summary span{font-size:12px;color:var(--muted);margin-left:8px}.adm-detail-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:16px 0}.adm-detail-toolbar button{flex-shrink:0}.adm-usage-details .adm-local-cost-evidence{border-top:1px solid var(--line);padding-top:18px;margin-top:18px}.adm-user-cost-details{margin-top:18px}
.adm-statement-heading h2{font-size:18px;font-weight:600;margin:0}.adm-statement-heading p{font-size:12px;line-height:1.7;color:var(--muted);margin:6px 0 0}
.adm-bill-status{font-size:12px;line-height:1.7;margin:8px 0 4px;color:var(--muted)}.adm-bill-period{font-size:11px;line-height:1.7;overflow-wrap:anywhere}.adm-provider-model{margin-top:16px!important}
.adm-cost-freshness{font-size:12px;line-height:1.7;color:var(--muted);margin:0!important}.adm-official-comparison{font-size:12px;line-height:1.7;border-top:1px solid var(--line);padding-top:12px;margin-top:12px}.adm-official-comparison b{font-variant-numeric:tabular-nums;font-weight:600}.adm-bill-notice{display:block;font-size:11px;line-height:1.7;color:var(--muted);margin-top:5px;overflow-wrap:anywhere}
.adm-provider-cost-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;align-items:stretch}
.adm-provider-cost-card{display:flex;flex-direction:column;min-width:0;padding:22px;background:#fff;border:1px solid var(--line,#e3e8dd);border-radius:12px}
.adm-provider-cost-card header{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;min-height:28px}
.adm-costs .adm-provider-cost-card h2{font-size:18px;margin:0}
.adm-channel-status,.adm-total-scope{font-size:11px;line-height:1.6;color:var(--muted)}
.adm-channel-status.available{color:#287459}
.adm-total-cost{background:#f1f6ef;border-color:#ccddc8}
.adm-total-scope{color:#376948}
.adm-provider-cost-card .adm-fee-label{font-size:12px;color:var(--muted);margin:16px 0 3px}
.adm-provider-amount{display:block;font-size:36px;line-height:1.3;letter-spacing:-.8px;font-weight:600;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.adm-provider-amount.is-pending{font-size:23px;letter-spacing:0;min-height:47px;display:flex;align-items:center}
.adm-provider-cost-card .adm-provider-usage{font-size:12px;line-height:1.7;color:var(--muted);margin:10px 0 18px}
.adm-provider-cost-card .adm-receipt-amount{font-size:13px;line-height:1.7;margin:10px 0;color:var(--muted)}
.adm-provider-cost-card .adm-bill-updated{font-size:11px;line-height:1.6;margin-top:6px;color:var(--muted);overflow-wrap:anywhere}
.adm-provider-cost-card .adm-cost-pending{font-size:12px;line-height:1.6;color:#8b601d;background:#fcf5e7;padding:8px 10px;border-radius:6px;margin:0 0 16px}
.adm-provider-cost-card .adm-provider-model,.adm-provider-cost-card .adm-character-total{font-size:12px;line-height:1.7;color:var(--muted);margin:auto 0 0;padding-top:14px;border-top:1px solid var(--line,#e3e8dd);overflow-wrap:anywhere}
.adm-provider-model b{display:block;color:var(--ink,#193e45);font-weight:500}
.adm-character-total b{display:block;font-size:20px;font-weight:600;color:var(--ink,#193e45);font-variant-numeric:tabular-nums}
.adm-character-total small{display:block;margin-top:4px}
.adm-provider-cost-card.is-excluded{background:#f8faf7}
.adm-provider-cost-card.is-excluded .adm-provider-amount{color:var(--muted)}
.adm-provider-costs>.adm-help{margin-bottom:0!important}
.adm-bill-provider{display:flex;justify-content:space-between;align-items:center;gap:20px;padding:18px 0;border-bottom:1px solid var(--line,#e3e8dd)}
.adm-bill-provider h3{margin:0}.adm-bill-provider p{margin:8px 0}.adm-bill-provider small{color:var(--muted)}
.adm-bill-actions{display:flex;gap:8px;flex-wrap:wrap}
details>summary{cursor:pointer;font-weight:600;line-height:1.6}details[open]>summary{margin-bottom:20px}
.adm-official-breakdown>summary span{font-size:12px;color:var(--muted);font-weight:400;margin-left:10px}
@media(max-width:1100px){.adm-provider-cost-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.adm-total-cost{grid-column:1/-1}}
@media(max-width:700px){.adm-provider-cost-grid{grid-template-columns:1fr}.adm-provider-cost-card{padding:20px}.adm-bill-provider{align-items:flex-start;flex-direction:column}.adm-total-cost{grid-column:auto}.adm-official-breakdown>summary span{display:block;margin:4px 0 0}}
</style>
