<script setup lang="ts">
import {computed,onMounted,onUnmounted,ref} from 'vue'
import AdminTable,{type Column} from './AdminTable.vue'
import {request,fmt,tokens,usd,date,label,localPreview,type Row} from './client'
const emit=defineEmits<{reconcile:[data:Row]}>()
const now=new Date(),to=ref(new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(now)),from=ref(to.value.slice(0,8)+'01')
const provider=ref(''),data=ref<Row>({}),busy=ref(false),error=ref(''),balance=ref<Row|null>(null),balanceError=ref('')
const totals=computed(()=>data.value.totals as Row||{})
const users=computed(()=>data.value.users as Row[]||[]),days=computed(()=>data.value.days as Row[]||[])
const columns:Column[]=[{key:'email',title:'用户'},{key:'requests',title:'请求数',format:r=>fmt(r.requests)},{key:'charged_characters',title:'已扣字符',format:r=>fmt(r.charged_characters)},{key:'total_tokens',title:'实际 Tokens',format:r=>tokens(r.total_tokens)},{key:'cost_usd',title:'已核算成本',format:r=>usd(r.cost_usd)},{key:'unpriced_requests',title:'未核算请求',format:r=>fmt(r.unpriced_requests)},{key:'unit',title:'每百万字符成本',format:r=>Number(r.priced_characters)>0?usd(Number(r.priced_character_cost)/Number(r.priced_characters)*1e6):'未核算'}]
const dayColumns:Column[]=[{key:'day',title:'日期（GMT+8）'},...columns.filter(c=>!['email','unit'].includes(c.key))]
let timer:ReturnType<typeof setInterval>|undefined,revision=0
async function load(){if(busy.value)return;const version=++revision;busy.value=true;error.value='';try{
  const result=await request<Row>('costs?'+new URLSearchParams({from:from.value,to:to.value,provider:provider.value}));if(version===revision)data.value=result
}catch(e){error.value=e instanceof Error?e.message:'暂时无法读取。'}finally{busy.value=false}}
async function readBalance(){balanceError.value='';try{balance.value=await request<Row>('provider-balance')}catch(e){balanceError.value=e instanceof Error?e.message:'无法查询余额。'}}
function reconcile(){emit('reconcile',{provider:provider.value||'deepseek',from:from.value,to:to.value})}
onMounted(()=>{void load();timer=setInterval(()=>{if(document.visibilityState==='visible')void load()},5000)})
onUnmounted(()=>{++revision;clearInterval(timer)})
</script>
<template><div class="adm-costs"><form class="adm-toolbar adm-card" @submit.prevent="load"><label>开始日期<input v-model="from" type="date" required /></label><label>结束日期<input v-model="to" type="date" required :min="from" /></label><label>API 服务<select v-model="provider"><option value="">全部</option><option value="deepseek">DeepSeek</option><option value="openai">OpenAI</option></select></label><button class="adm-primary" :disabled="busy">{{busy?'读取中…':'查询用量'}}</button><button class="adm-button" type="button" @click="reconcile">核对官方账单</button></form>
  <p v-if="error" class="adm-error" role="alert">{{error}} 下方保留上次读取结果。</p>
  <section class="adm-stat-grid"><article><span>客户端已扣字符</span><strong>{{fmt(totals.charged_characters)}}</strong><small>补偿 {{fmt(totals.refunded_characters)}} 字符</small></article><article><span>云端翻译请求</span><strong>{{fmt(totals.requests)}}</strong><small>{{fmt(totals.metered_requests)}} 条有 Token 回执</small></article><article><span>实际 Tokens</span><strong>{{tokens(totals.total_tokens)}}</strong><small>输入 {{tokens(totals.input_tokens)}} · 输出 {{tokens(totals.output_tokens)}}</small></article><article><span>已核算 API 成本 · USD</span><strong class="adm-cost-value">{{usd(totals.cost_usd)}}</strong><small>{{fmt(totals.priced_requests)}} 条已核算 · {{fmt(totals.unpriced_requests)}} 条待核算</small></article></section>
  <section class="adm-card adm-cost-explanation"><h2>费用计算依据</h2><p>使用每次 API 返回的输入、缓存命中和输出 Tokens，分别乘以该请求时段的官方美元单价。提示词与上下文计入 API 用量；推理 Tokens 已包含在输出中，不重复相加。</p><p>字符是客户端额度。下表的每百万字符成本，仅由同一批已核算请求的真实字符和费用换算，作为成本统计。</p><p v-if="Number(totals.unpriced_requests)>0" class="adm-cost-warning">{{fmt(totals.unpriced_requests)}} 条请求缺少完整核算数据，其中 {{fmt(totals.historical_requests)}} 条为历史记录。当前金额不代表完整账期总费用。</p><p v-if="Number(totals.provider_only_requests)>0">{{fmt(totals.provider_only_requests)}} 条请求产生了 API 用量，但未扣客户字符。</p><a href="https://api-docs.deepseek.com/quick_start/pricing/" target="_blank" rel="noopener">DeepSeek 官方价格 ↗</a><small>使用单价版本 {{data.priceVersion}}，历史记录保留原单价。</small></section>
  <section class="adm-card"><h2>按用户统计</h2><AdminTable :rows="users" :columns="columns" empty="所选期间没有请求。" /></section>
  <section class="adm-card"><h2>每日用量</h2><AdminTable :rows="days" :columns="dayColumns" /></section>
  <section class="adm-card"><div class="adm-cost-balance-heading"><h2>DeepSeek 官方账号余额</h2><button class="adm-button" :disabled="localPreview" @click="readBalance">查询官方余额</button></div><p class="adm-help">官方余额接口提供账号余额；账期费用通过官方用量账单核对。此处不会把充值、赠金或余额变化当成用户翻译费用。</p><p v-if="balanceError" class="adm-error">{{balanceError}}</p><div v-if="balance" class="adm-balance-results"><p v-for="item in balance.balances as Row[]" :key="String(item.currency)"><b>{{item.currency}} {{item.total}}</b> · 赠金 {{item.granted}} · 充值余额 {{item.paid}}</p><small>查询时间 {{date(balance.snapshotAt)}}</small></div></section>
  <p class="adm-help">按 GMT+8 日期统计，每 5 秒自动刷新。读取于 {{date(data.snapshotAt)}}。</p>
</div></template>
