<script setup lang="ts">
import {computed,onMounted,onUnmounted,ref,watch} from 'vue'
import {request,fmt,localPreview,type Row} from './client'
import {currentBillPeriod,enabledBillProviders} from './officialBills'
import {parseProviderBalance,utcTimestamp,type ProviderBalance} from './providerBalance'
import ProviderFundingCard from './ProviderFundingCard.vue'
import {ReadPolling} from './readPolling'

const props=defineProps<{identity:string;canReadCosts:boolean;officialAccess:boolean}>()
const data=ref<Row>({}),busy=ref(false),error=ref(''),clock=ref(Date.now())
const queried=ref({...currentBillPeriod('UTC'),timezone:'UTC',provider:''})
const balance=ref<ProviderBalance|null>(null),balanceError=ref(''),balanceBusy=ref(false),balanceReadAt=ref(Date.now())
const balanceClock=computed(()=>balance.value?Date.parse(balance.value.checkedAt)+Math.max(0,clock.value-balanceReadAt.value):clock.value)
const deepseekEnabled=computed(()=>enabledBillProviders(data.value).includes('deepseek'))
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
 const version=++balanceRevision,identity=props.identity;balanceBusy.value=true;balanceError.value=''
 try{const result=parseProviderBalance(await request<unknown>('provider-balance'));if(!disposed&&version===balanceRevision&&identity===props.identity&&props.officialAccess){balance.value=result;balanceReadAt.value=Date.now();balancePolling.succeeded()}}
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
 const version=++revision,identity=props.identity
 const selected={...currentBillPeriod('UTC'),timezone:'UTC',provider:''}
 busy.value=true
 const work=(async()=>{
  try{
   const result=await request<Row>('costs?'+new URLSearchParams(selected))
   if(disposed||version!==revision||identity!==props.identity||!props.canReadCosts)return
   if(!matchesPeriod(result,selected))throw new Error('账期数据尚未核实，请稍后刷新。')
   data.value=props.officialAccess?result:{...result,officialBills:[]}
   queried.value=selected;clock.value=Date.now();error.value='';readPolling.succeeded()
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
 queried.value={...currentBillPeriod('UTC'),timezone:'UTC',provider:''}
 void refresh()
},{flush:'sync'})
onMounted(()=>void refresh())
onUnmounted(()=>{disposed=true;++revision;++balanceRevision;again=false;inFlight=undefined})
defineExpose({refresh})
</script>

<template>
 <article v-if="canReadCosts" class="adm-overview-characters" :aria-busy="busy">
  <span>本月已用字符</span><strong>{{characters===null?(busy?'读取中…':'尚未取得'):fmt(characters)}}</strong>
  <small>{{queried.from}} 至 {{queried.to}}<br />UTC · 全部通道 · 与用量页默认账期一致</small>
  <small v-if="data.snapshotAt" class="adm-overview-sampled">读取于 {{utcTimestamp(data.snapshotAt)}}</small>
  <p v-if="error" class="adm-overview-delayed" role="status">{{characters===null?'本月数据读取失败，未显示为零。':'读取失败，保留上次数据；当前显示可能过期。'}} {{error}}</p>
 </article>
 <ProviderFundingCard v-if="canReadCosts&&officialAccess&&deepseekEnabled" class="adm-overview-funding" compact :balance="balance" :error="balanceError" :busy="balanceBusy" :now="balanceClock" :local-preview="localPreview" @refresh="readBalance()" />
</template>
<style scoped>
.adm-overview-pending{font-size:23px!important;letter-spacing:0!important}.adm-overview-sampled{display:block;margin-top:10px}.adm-overview-partial{font-size:15px;line-height:1.6;margin:10px 0}.adm-overview-delayed{font-size:12px;line-height:1.7;color:#966119;overflow-wrap:anywhere}.adm-overview-cost-link{display:block;margin-top:12px;font-size:13px;color:var(--green,#28553e)}
</style>
