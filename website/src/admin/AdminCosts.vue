<script setup lang="ts">
import {computed,onMounted,onUnmounted,ref,watch} from 'vue'
import AdminTable,{type Column} from './AdminTable.vue'
import {request,fmt,tokens,usd,localPreview,type Row} from './client'
import {currencyAmount} from './money'
import {parseProviderBalance,balanceState,utcTimestamp,type ProviderBalance} from './providerBalance'
import {currentBillPeriod,officialBillSummary,officialBillDelayed} from './officialBills'
const props=defineProps<{officialAccess:boolean}>()
const emit=defineEmits<{reconcile:[data:Row]}>()
const to=ref(new Date().toISOString().slice(0,10)),from=ref(to.value.slice(0,8)+'01'),provider=ref(''),timezone=ref('UTC')
const followCurrentPeriod=ref(true)
const data=ref<Row>({}),busy=ref(false),error=ref(''),syncBusy=ref(false),syncInfo=ref<Row>({}),syncMessage=ref('')
const syncFailure=ref<{from:string;to:string;after:number}|null>(null)
const queried=ref({from:from.value,to:to.value,provider:provider.value,timezone:timezone.value})
const balance=ref<ProviderBalance|null>(null),balanceError=ref(''),balanceBusy=ref(false),clock=ref(Date.now())
const costsReadAt=ref(Date.now())
const billingClock=computed(()=>{const snapshot=Date.parse(String(data.value.snapshotAt||''));return Number.isFinite(snapshot)?snapshot+Math.max(0,clock.value-costsReadAt.value):clock.value})
const balanceStatus=computed(()=>balanceState(balance.value,balanceError.value,clock.value))
const totals=computed(()=>data.value.totals as Row||{}),users=computed(()=>data.value.users as Row[]||[]),days=computed(()=>data.value.days as Row[]||[])
const providers=computed(()=>data.value.providers as Row[]||[])
const official=computed(()=>officialBillSummary(props.officialAccess?data.value:{},queried.value,clock.value))
const oldestOfficial=computed(()=>official.value.items.map(item=>item.fetchedAt).sort((a,b)=>Date.parse(a)-Date.parse(b))[0])
const officialDelayed=computed(()=>officialBillDelayed(official.value,queried.value,billingClock.value))
const billingIssue=computed(()=>{const state=syncInfo.value.sync as Row|undefined;return state?.status==='error'?String(state.message||'OpenAI 官方账单暂时无法同步，保留上次金额。'):''})
const incomplete=computed(()=>Number(totals.value.unpriced_requests)>0)
const known=(row:Row)=>row.known_cost_usd_exact??row.known_cost_usd??row.cost_usd
const bill=(name:string)=>official.value.items.find(b=>b.provider===name)
const providerName=(name:string)=>name==='openai'?'OpenAI':'DeepSeek'
const local=(name:string)=>providers.value.find(b=>b.provider===name)
const columns:Column[]=[{key:'email',title:'用户'},{key:'charged_characters',title:'已扣字符',format:r=>fmt(r.charged_characters)},
  {key:'known_cost_usd',title:'按回执核算 · USD',format:r=>usd(known(r))},{key:'unpriced_requests',title:'待核算调用',format:r=>fmt(r.unpriced_requests)}]
const dayColumns:Column[]=[{key:'day',title:'日期'},...columns.filter(c=>c.key!=='email')]
let timer:ReturnType<typeof setInterval>|undefined,balanceTimer:ReturnType<typeof setInterval>|undefined,revision=0,balanceRevision=0,disposed=false,statusAt=0,refreshAfterLoad=false,accessRevision=0,statusRevision=0
async function load(applyFilters=false){if(disposed)return;if(busy.value){if(!applyFilters)refreshAfterLoad=true;return}const version=++revision,accessVersion=accessRevision;busy.value=true;error.value='';try{
  const selected=applyFilters?{from:from.value,to:to.value,provider:provider.value,timezone:timezone.value}:{...queried.value}
  if(followCurrentPeriod.value){Object.assign(selected,currentBillPeriod('UTC'));from.value=selected.from;to.value=selected.to}
  const result=await request<Row>('costs?'+new URLSearchParams(selected));if(version===revision){data.value=props.officialAccess&&accessVersion===accessRevision?result:{...result,officialBills:[]};costsReadAt.value=Date.now();queried.value=selected}
}catch(e){if(version===revision)error.value=e instanceof Error?e.message:'暂时无法读取。'}finally{if(version===revision){busy.value=false;if(refreshAfterLoad&&!disposed){refreshAfterLoad=false;void load()}}}}
async function readSyncStatus(force=false){if(localPreview||!props.officialAccess||disposed||(!force&&Date.now()-statusAt<60000))return;statusAt=Date.now();const version=++statusRevision,accessVersion=accessRevision;try{const value=await request<Row>('billing-status');if(!disposed&&props.officialAccess&&version===statusRevision&&accessVersion===accessRevision)syncInfo.value=value}catch{if(!disposed&&props.officialAccess&&version===statusRevision&&accessVersion===accessRevision)syncInfo.value={...syncInfo.value,statusReadError:'暂时无法读取官方账单连接状态，保留上次结果。'}}}
async function sync(){if(syncBusy.value||!props.officialAccess||disposed)return;const accessVersion=accessRevision,period={from:queried.value.from,to:queried.value.to};syncBusy.value=true;syncMessage.value='';syncFailure.value=null;try{
  const result=await request<Row>('billing-sync',period);if(!disposed&&props.officialAccess&&accessVersion===accessRevision){syncMessage.value=String(result.message||'官方账单已同步。');await load()}
}catch(e){if(!disposed&&props.officialAccess&&accessVersion===accessRevision){syncMessage.value=e instanceof Error?e.message:'同步未完成，已保留上次结果。';syncFailure.value={...period,after:billingClock.value}}}finally{if(!disposed&&props.officialAccess&&accessVersion===accessRevision){syncBusy.value=false;void readSyncStatus(true)}}}
async function readBalance(){if(balanceBusy.value||localPreview||!props.officialAccess||disposed)return;const version=++balanceRevision;balanceBusy.value=true;balanceError.value='';try{
  // Use only this account-scoped endpoint. A historical cost summary may carry
  // a balance from an older provider account and must never fill a missing value.
  const result=parseProviderBalance(await request<unknown>('provider-balance'));if(version===balanceRevision&&!disposed&&props.officialAccess)balance.value=result
}catch(e){if(version===balanceRevision&&!disposed)balanceError.value=e instanceof Error?e.message:'无法查询余额。'}finally{if(version===balanceRevision&&!disposed){balanceBusy.value=false;clock.value=Date.now()}}}
function reconcile(name:string){emit('reconcile',{provider:name,from:queried.value.from,to:queried.value.to,timezone:name==='deepseek'?'Asia/Shanghai':'UTC'})}
function resume(){clock.value=Date.now();if(document.visibilityState==='visible'){void load();void readBalance();void readSyncStatus()}}
watch([official,syncFailure],()=>{const failure=syncFailure.value,bill=official.value.items.find(item=>item.provider==='openai'&&item.source==='openai_costs_api');if(failure&&bill&&queried.value.from===failure.from&&queried.value.to===failure.to&&Date.parse(bill.fetchedAt)>failure.after){syncFailure.value=null;syncMessage.value='OpenAI 官方账单已恢复同步。';void readSyncStatus(true)}})
watch(()=>props.officialAccess,value=>{++balanceRevision;++accessRevision;++statusRevision;data.value={...data.value,officialBills:[]};balance.value=null;balanceError.value='';balanceBusy.value=false;syncBusy.value=false;syncMessage.value='';syncFailure.value=null;syncInfo.value={};statusAt=0;if(value){void load();void readBalance();void readSyncStatus()}})
onMounted(()=>{void load(true);void readSyncStatus();void readBalance();timer=setInterval(()=>{clock.value=Date.now();if(document.visibilityState==='visible')void load()},10000);balanceTimer=setInterval(()=>{if(document.visibilityState==='visible'){void readBalance();void readSyncStatus()}},30000);document.addEventListener('visibilitychange',resume);window.addEventListener('online',resume)})
onUnmounted(()=>{disposed=true;++revision;++balanceRevision;clearInterval(timer);clearInterval(balanceTimer);document.removeEventListener('visibilitychange',resume);window.removeEventListener('online',resume)})
</script>
<template><div class="adm-costs">
  <form class="adm-toolbar adm-card" @submit.prevent="load(true)"><label>开始日期<input v-model="from" type="date" required :disabled="busy||syncBusy" @input="followCurrentPeriod=false" /></label><label>结束日期<input v-model="to" type="date" required :min="from" :disabled="busy||syncBusy" @input="followCurrentPeriod=false" /></label>
    <label>业务统计时区<select v-model="timezone" :disabled="busy||syncBusy"><option value="UTC">UTC</option><option value="Asia/Shanghai">GMT+8</option></select></label>
    <label>翻译通道<select v-model="provider" :disabled="busy||syncBusy"><option value="">全部</option><option value="openai">OpenAI</option><option value="deepseek">DeepSeek</option></select></label>
    <button class="adm-primary" :disabled="busy">{{busy?'读取中…':'查询'}}</button></form>
  <p v-if="error" class="adm-error" role="alert">{{error}} 下方保留上次结果。</p>
  <p class="adm-help">业务用量账期：{{queried.from}} 至 {{queried.to}} · {{queried.timezone==='UTC'?'UTC':'GMT+8'}} · {{queried.provider||'全部通道'}} · {{followCurrentPeriod?'默认本月日期按 UTC 自动更新':'按所选日期查询'}}</p>
  <section class="adm-stat-grid adm-billing-kpis" :class="{'with-balance':officialAccess}">
    <article><span>已用字符</span><strong>{{data.totals?fmt(totals.charged_characters):'读取中…'}}</strong><small>所选账期 · 已补偿 {{fmt(totals.refunded_characters)}} 字符<br />备用切换不会重复扣字符</small></article>
    <article v-if="officialAccess" class="adm-official-cost"><span>各平台官方账单合计 · USD</span><strong v-if="official.complete" class="adm-cost-value">{{usd(official.total)}}</strong><strong v-else class="adm-official-pending">尚缺官方账单</strong>
      <p v-if="!official.complete&&official.partial!==null" class="adm-official-partial">已同步部分：{{usd(official.partial)}}<br /><small>不是完整合计</small></p>
      <small v-if="!official.complete">待同步：{{official.missing.map(providerName).join('、')}}<br /></small><small>{{queried.from}} 至 {{queried.to}}<br />{{queried.provider==='openai'?'OpenAI UTC':queried.provider==='deepseek'?'DeepSeek GMT+8':'OpenAI UTC · DeepSeek GMT+8'}}<br />随官方账单同步更新，近期费用仍可能补记</small>
      <small v-if="oldestOfficial" class="adm-official-sampled">本次汇总最早采集 / 录入：<br />{{utcTimestamp(oldestOfficial)}}</small><p v-if="billingIssue&&queried.provider!=='deepseek'" class="adm-error" role="alert">{{billingIssue}}</p><p v-else-if="officialDelayed" class="adm-help adm-balance-state delayed" role="status">官方账单同步有延迟，保留上次金额。</p></article>
    <article v-if="officialAccess" class="adm-provider-balance" :aria-busy="balanceBusy">
      <div class="adm-balance-heading"><span>DeepSeek 官方余额</span><button class="adm-button" :disabled="balanceBusy||localPreview" @click="readBalance">{{balanceBusy?'查询中…':'刷新余额'}}</button></div>
      <div v-if="balance?.balances.length" class="adm-balance-amounts"><strong v-for="item in balance.balances" :key="item.currency" class="adm-balance-total">{{currencyAmount(item.total,item.currency)}}</strong></div><strong v-else class="adm-balance-empty">{{balanceBusy?'正在查询…':'尚未取得'}}</strong>
      <p class="adm-balance-state" :class="{delayed:balanceStatus.delayed}" role="status">{{localPreview?'本地演示不查询官方余额':balanceStatus.label}}</p>
      <small>官方采集时间：{{utcTimestamp(balance?.fetchedAt)}}<br />页面可见时每 30 秒核对，不同币种分别显示</small>
      <p v-if="balanceError" class="adm-error" role="alert">{{balanceError}}</p>
      <p v-if="balance?.available===false" class="adm-help">官方账户当前不可用，请到 DeepSeek 平台核对。</p>
      <details v-if="balance?.balances.length" class="adm-balance-details"><summary>余额明细</summary><p v-for="item in balance.balances" :key="item.currency"><b>{{item.currency}}</b><br />充值余额 {{currencyAmount(item.paid,item.currency)}}<br />赠金余额 {{currencyAmount(item.granted,item.currency)}}</p></details>
      <small>官方账户余额不随上方账期筛选变化，也不等于账期花费。</small>
    </article>
  </section>
  <section v-if="officialAccess" class="adm-card adm-official-breakdown"><h2>官方账单明细</h2><p class="adm-help">按相同日历日期汇总当前账号的各平台账单：OpenAI 使用 UTC，DeepSeek 使用 GMT+8，实际时间边界不同。未取得任一通道账单时，只显示已同步部分。余额变化包含充值、赠金和其他调用，不用于补齐费用。</p>
    <div v-for="name in (queried.provider?[queried.provider]:['openai','deepseek'])" :key="name" class="adm-bill-provider">
      <div><h3>{{providerName(name)}}</h3>
        <small>{{queried.from}} 至 {{queried.to}} · {{name==='openai'?'UTC':'GMT+8'}}</small>
        <p>官方账期费用：<b>{{bill(name)?usd(bill(name)?.amount):'尚未同步该账期'}}</b></p>
        <small v-if="bill(name)">{{bill(name)?.source==='manual_statement'?'官方账单 · 手动录入':'官方 Costs API 快照'}} · {{bill(name)?.source==='manual_statement'?'录入于':'采集于'}} {{utcTimestamp(bill(name)?.fetchedAt)}}<br />{{bill(name)?.provisional?'近期费用仍可能补记':'按该次账单记录'}}</small>
      </div>
      <div class="adm-bill-actions"><button v-if="name==='openai'" class="adm-primary" :disabled="busy||syncBusy||!syncInfo.configured||localPreview" @click="sync">{{syncBusy?'同步中…':'同步官方账单'}}</button><button class="adm-button" :disabled="busy||syncBusy" @click="reconcile(name)">录入账单核对</button></div>
    </div>
    <p v-if="syncInfo.statusReadError" class="adm-help" role="status">{{syncInfo.statusReadError}}</p>
    <p v-if="!syncInfo.configured&&!syncInfo.statusReadError" class="adm-help">{{syncInfo.message||'官方账单同步尚未配置。'}}</p>
    <p class="adm-help">更换过服务商账号时，旧账号费用需另行核对。DeepSeek 官方接口可查询余额；账期费用使用官方导出账单核对，余额变化不会当作翻译成本。</p><p v-if="syncMessage" class="adm-help" role="status">{{syncMessage}}</p>
  </section>
  <section class="adm-card"><h2>按用户统计</h2><p class="adm-help">用户费用按调用回执核算，供用量分析；官方账单不能直接分摊到每个用户。</p><AdminTable :rows="users" :columns="columns" empty="所选期间没有请求。" /></section>
  <details class="adm-card adm-local-cost-evidence"><summary>查看每日用量和核算依据</summary>
    <p>按回执核算 · USD：<b>{{usd(known(totals))}}</b><span v-if="incomplete"> · {{fmt(totals.unpriced_requests)}} 次调用仍待核算，当前不是完整总额</span></p>
    <p v-for="name in (queried.provider?[queried.provider]:['openai','deepseek'])" :key="name">{{providerName(name)}} 回执：{{usd(known(local(name)||{}))}}<span v-if="Number(local(name)?.unpriced_requests)>0"> · 含待核算调用</span></p>
    <p class="adm-help">以下金额按调用回执和当时单价计算，作为核算依据，不作为官方扣费金额。</p><AdminTable :rows="days" :columns="dayColumns" />
    <p v-if="incomplete" class="adm-help">待核算原因：{{fmt(totals.missing_receipt_requests)}} 次缺少回执，{{fmt(totals.missing_cache_requests)}} 次缺少缓存明细，{{fmt(totals.missing_price_requests)}} 次缺少当时的计价依据。历史缺失不会用当前价格或零费用补填。</p>
    <p class="adm-help">{{fmt(totals.provider_requests)}} 次通道调用 · 输入 {{tokens(totals.input_tokens)}} Tokens · 输出 {{tokens(totals.output_tokens)}} Tokens。缓存读取、缓存写入和输出分别计价；推理 Tokens 已包含在输出中。失败调用可能产生服务商费用，但不扣用户字符。</p>
    <p class="adm-help">按通道筛选时，字符仅归属实际返回译文的通道。费用包含该通道所有尝试，避免切换后漏记费用。</p>
    <p class="adm-help">API 费用按通道实际调用时间计入账期；字符按翻译请求创建时间归属。跨日重试可能落在不同日期。</p>
    <p><a href="https://developers.openai.com/api/docs/pricing" target="_blank" rel="noopener">OpenAI 官方价格 ↗</a> · <a href="https://api-docs.deepseek.com/quick_start/pricing/" target="_blank" rel="noopener">DeepSeek 官方价格 ↗</a></p>
  </details>
  <p class="adm-help">当前按 {{queried.timezone==='UTC'?'UTC':'GMT+8'}} 账期统计，每 10 秒读取最新流水和已同步账单。读取于 {{utcTimestamp(data.snapshotAt)}}。</p>
</div></template>
<style scoped>
.adm-billing-kpis{grid-template-columns:repeat(2,minmax(0,1fr));align-items:start}.adm-billing-kpis.with-balance{grid-template-columns:repeat(3,minmax(0,1fr))}.adm-bill-provider{display:flex;justify-content:space-between;align-items:center;gap:20px;padding:18px 0;border-bottom:1px solid var(--line,#e3e8dd)}.adm-bill-provider h3{margin:0}.adm-bill-provider p{margin:8px 0}.adm-bill-actions,.adm-balance-heading{display:flex;gap:8px;flex-wrap:wrap}.adm-balance-heading{align-items:center;justify-content:space-between}.adm-bill-provider small{color:var(--muted)}.adm-provider-balance .adm-balance-total{font-size:20px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;line-height:1.5;margin:12px 0}.adm-provider-balance .adm-balance-empty{font-size:24px}.adm-balance-state{font-size:12px;color:#287459}.adm-balance-state.delayed{color:#a06418}.adm-balance-details{font-size:12px;margin:14px 0}.adm-balance-details p{line-height:1.8;overflow-wrap:anywhere}.adm-balance-details>summary{margin-bottom:8px}.adm-balance-heading button{font-size:12px;padding:7px 10px}details>summary{cursor:pointer;font-weight:600;margin-bottom:20px}@media(max-width:1100px){.adm-billing-kpis.with-balance{grid-template-columns:repeat(2,minmax(0,1fr))}.adm-provider-balance{grid-column:1/-1}}@media(max-width:700px){.adm-bill-provider{align-items:flex-start;flex-direction:column}.adm-billing-kpis,.adm-billing-kpis.with-balance{grid-template-columns:1fr}}
.adm-official-cost .adm-official-pending{font-size:24px;line-height:1.5}.adm-official-cost .adm-cost-value{overflow-wrap:anywhere}.adm-official-partial{font-size:16px;line-height:1.6;margin:10px 0}.adm-official-partial small{font-size:12px}
.adm-official-sampled{display:block;margin-top:10px}
</style>
