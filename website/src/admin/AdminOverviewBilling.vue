<script setup lang="ts">
import {computed,onMounted,onUnmounted,ref,watch} from 'vue'
import {request,fmt,usd,type Row} from './client'
import {currentBillPeriod,officialBillSummary,officialBillDelayed} from './officialBills'
import {utcTimestamp} from './providerBalance'

const props=defineProps<{identity:string;canReadCosts:boolean;officialAccess:boolean}>()
const data=ref<Row>({}),busy=ref(false),error=ref(''),clock=ref(Date.now()),readAt=ref(Date.now())
const queried=ref({...currentBillPeriod('UTC'),timezone:'UTC',provider:''})
const official=computed(()=>officialBillSummary(props.officialAccess?data.value:{},queried.value,clock.value))
const characters=computed(()=>{
 const value=(data.value.totals as Row|undefined)?.charged_characters
 if(value===null||value===undefined||value==='')return null
 const amount=typeof value==='number'?value:typeof value==='string'&&/^\d+$/.test(value)?Number(value):NaN
 return Number.isSafeInteger(amount)&&amount>=0?amount:null
})
const sampled=computed(()=>official.value.items.map(item=>item.fetchedAt).sort((a,b)=>Date.parse(a)-Date.parse(b))[0])
const billingClock=computed(()=>{const time=Date.parse(String(data.value.snapshotAt||''));return Number.isFinite(time)?time+Math.max(0,clock.value-readAt.value):clock.value})
const delayed=computed(()=>officialBillDelayed(official.value,queried.value,billingClock.value))
let revision=0,disposed=false,again=false,inFlight:Promise<void>|undefined
function matchesPeriod(value:Row,period:typeof queried.value){
 if(!value||typeof value!=='object'||Array.isArray(value))return false
 return value.timezone==='UTC'&&Date.parse(String(value.from))===Date.parse(period.from+'T00:00:00Z')
  &&Date.parse(String(value.toExclusive))===Date.parse(period.to+'T00:00:00Z')+86400000
  &&Number.isFinite(Date.parse(String(value.snapshotAt)))
}
async function refresh():Promise<void>{
 clock.value=Date.now()
 if(disposed||!props.canReadCosts)return
 if(inFlight){again=true;return inFlight}
 const version=++revision,identity=props.identity
 const selected={...currentBillPeriod('UTC'),timezone:'UTC',provider:''}
 busy.value=true
 const work=(async()=>{
  try{
   const result=await request<Row>('costs?'+new URLSearchParams(selected))
   if(disposed||version!==revision||identity!==props.identity||!props.canReadCosts)return
   if(!matchesPeriod(result,selected))throw new Error('账期数据尚未核实，请稍后刷新。')
   data.value=props.officialAccess?result:{...result,officialBills:[]}
   queried.value=selected;readAt.value=Date.now();clock.value=readAt.value;error.value=''
  }catch(e){
   if(!disposed&&version===revision&&identity===props.identity){
    if(e&&typeof e==='object'&&'code' in e&&['unauthorized','admin_forbidden'].includes(String(e.code)))data.value={}
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
 ++revision;inFlight=undefined;again=false;data.value={};error.value='';busy.value=false
 queried.value={...currentBillPeriod('UTC'),timezone:'UTC',provider:''}
 void refresh()
},{flush:'sync'})
onMounted(()=>void refresh())
onUnmounted(()=>{disposed=true;++revision;again=false;inFlight=undefined})
defineExpose({refresh})
</script>

<template>
 <article v-if="canReadCosts" class="adm-overview-characters" :aria-busy="busy">
  <span>本月已用字符</span><strong>{{characters===null?(busy?'读取中…':'尚未取得'):fmt(characters)}}</strong>
  <small>{{queried.from}} 至 {{queried.to}}<br />UTC · 全部通道 · 与用量页默认账期一致</small>
  <small v-if="data.snapshotAt" class="adm-overview-sampled">读取于 {{utcTimestamp(data.snapshotAt)}}</small>
  <p v-if="error" class="adm-overview-delayed" role="status">{{characters===null?'本月数据读取失败，未显示为零。':'读取失败，保留上次数据；当前显示可能过期。'}} {{error}}</p>
 </article>
 <article v-if="canReadCosts&&officialAccess" class="adm-overview-official" :aria-busy="busy">
  <span>各平台官方账单合计 · USD</span>
  <strong v-if="official.complete" class="adm-cost-value">{{usd(official.total)}}</strong>
  <strong v-else class="adm-overview-pending">{{busy&&!data.snapshotAt?'读取中…':'尚缺官方账单'}}</strong>
  <p v-if="!official.complete&&official.partial!==null" class="adm-overview-partial">已同步部分：{{usd(official.partial)}}<br /><small>不是完整合计</small></p>
  <small v-if="!official.complete">待同步：{{official.missing.map(name=>name==='openai'?'OpenAI':'DeepSeek').join('、')}}<br /></small>
  <small>{{queried.from}} 至 {{queried.to}}<br />OpenAI UTC · DeepSeek GMT+8</small>
  <small v-if="sampled" class="adm-overview-sampled">本次汇总最早采集 / 录入：<br />{{utcTimestamp(sampled)}}</small>
  <p v-if="error||delayed" class="adm-overview-delayed" role="status">{{error?(data.snapshotAt?'读取失败，保留上次账单；当前显示可能过期。':'官方账单读取失败，尚未取得可用金额。'):'官方账单同步有延迟，保留上次金额。'}}</p>
  <small>与用量页默认本月、全部通道口径一致</small>
  <a class="adm-overview-cost-link" href="/admin/costs">查看用量与费用 →</a>
 </article>
</template>
<style scoped>
.adm-overview-pending{font-size:23px!important;letter-spacing:0!important}.adm-overview-sampled{display:block;margin-top:10px}.adm-overview-partial{font-size:15px;line-height:1.6;margin:10px 0}.adm-overview-delayed{font-size:12px;line-height:1.7;color:#966119;overflow-wrap:anywhere}.adm-overview-cost-link{display:block;margin-top:12px;font-size:13px;color:var(--green,#28553e)}
</style>
