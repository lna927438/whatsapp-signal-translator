<script setup lang="ts">
import {computed} from 'vue'
import {usd,currencyAmount} from './money'
import {balanceState,utcTimestamp,type ProviderBalance} from './providerBalance'
import {fundingDecimal} from './providerFunding'
const props=defineProps<{balance:ProviderBalance|null;error:string;busy:boolean;now:number;compact?:boolean;localPreview?:boolean}>()
const emit=defineEmits<{refresh:[];confirm:[]}>()
const funding=computed(()=>props.balance?.funding),usdBalance=computed(()=>props.balance?.balances.find(item=>item.currency==='USD'))
const state=computed(()=>balanceState(props.balance,props.error,props.now))
const delayed=computed(()=>state.value.delayed||funding.value?.status==='stale')
const used=computed(()=>['ready','stale'].includes(funding.value?.status||'')?funding.value?.usedPaid:null)
const needsConfirmation=computed(()=>!funding.value||['unconfigured','needs_confirmation'].includes(funding.value.status))
const nonzero=(value:unknown)=>{const amount=fundingDecimal(value);return amount!==null&&amount!==0n}
</script>
<template><article class="adm-provider-funding" :class="{'adm-funding-compact':compact}" :aria-busy="busy">
 <div class="adm-funding-heading"><span>DeepSeek 累计资金 · USD</span><button class="adm-button" :disabled="busy||localPreview" @click="emit('refresh')">{{busy?'查询中…':compact?'刷新':'刷新资金'}}</button></div>
 <div class="adm-funding-values">
  <div class="adm-funding-used"><span>累计已用（余额核算）</span><strong v-if="used!==null&&used!==undefined" class="adm-cost-value">{{usd(used)}}</strong><strong v-else class="adm-funding-empty">{{busy&&!balance?'读取中…':needsConfirmation?'待确认累计充值':'暂未取得'}}</strong></div>
  <div class="adm-funding-topups"><span>累计充值</span><strong>{{funding?.cumulativeTopUps!=null?usd(funding.cumulativeTopUps):'尚未确认'}}</strong></div>
  <div class="adm-funding-balance"><span>官方余额</span><strong>{{usdBalance?usd(usdBalance.total):busy?'读取中…':'尚未取得'}}</strong></div>
 </div>
 <p v-if="funding?.status==='needs_confirmation'" class="adm-funding-warning" role="status">余额或资金记录有变化，请确认累计充值与退款后再核算已用。</p>
 <p v-else-if="needsConfirmation&&!busy" class="adm-funding-warning" role="status">确认此账号的累计充值与退款后，可按官方余额核算累计已用。</p>
 <p v-if="!compact||delayed||!balance?.balances.length" class="adm-balance-state" :class="{delayed}" role="status">{{localPreview?'本地演示不查询官方余额':delayed&&balance?.balances.length?'同步有延迟，当前显示上次核对的资金数据。':state.label}}</p>
 <small>官方余额更新于 {{utcTimestamp(balance?.fetchedAt)}}<br />页面可见时每 30 秒同步</small>
 <p v-if="error" class="adm-error" role="alert">{{error}}</p>
 <p v-if="balance?.available===false" class="adm-funding-warning">官方账户当前不可用，请到 DeepSeek 平台核对。</p>
 <p v-if="nonzero(funding?.cumulativeCashRefunds)" class="adm-funding-adjustments">累计现金退款 {{usd(funding?.cumulativeCashRefunds)}} · 净充值 {{usd(funding?.netPaidFunding)}}</p>
 <p v-if="usdBalance&&nonzero(usdBalance.granted)" class="adm-funding-adjustments">充值余额 {{usd(usdBalance.paid)}} · 赠金余额 {{usd(usdBalance.granted)}}（赠金不计入充值已用）</p>
 <small class="adm-funding-basis">{{compact?'当前账号累计资金，不随账期筛选变化。':'当前账号累计资金，不随日期或通道筛选变化。已用按净充值减官方充值余额核算。'}}</small>
 <details v-if="!compact&&balance?.balances.length" class="adm-funding-details"><summary>资金核算明细</summary><p v-for="item in balance.balances" :key="item.currency"><b>{{item.currency}}</b> · 官方余额 {{currencyAmount(item.total,item.currency)}}<br />充值余额 {{currencyAmount(item.paid,item.currency)}} · 赠金余额 {{currencyAmount(item.granted,item.currency)}}</p><p>累计充值由管理员确认于 {{utcTimestamp(funding?.confirmedAt)}}。现金退款只填写已退回付款渠道的金额。退回服务商余额的费用不填现金退款，余额核对后会降低累计已用。</p><p>这里是当前账号资金核算，不是所选账期账单，也不能直接分摊为每位用户的翻译费用。</p></details>
 <button v-if="!compact" class="adm-button adm-funding-confirm" :disabled="busy||localPreview||!usdBalance||!balance?.fetchedAt||delayed" @click="emit('confirm')">登记充值 / 退款</button>
 <a v-if="compact" class="adm-funding-link" href="/admin/costs">查看用量与资金 →</a>
</article></template>
<style scoped>
.adm-provider-funding{min-width:0}.adm-funding-compact .adm-funding-heading{gap:5px}.adm-funding-compact .adm-funding-heading span{font-size:11px}.adm-funding-compact .adm-funding-heading button{padding:4px 7px;font-size:11px}.adm-funding-compact small{font-size:11px!important}.adm-funding-compact .adm-funding-values{margin:12px 0}.adm-funding-heading{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}.adm-funding-heading button{font-size:12px;padding:7px 10px}.adm-funding-values{display:grid;grid-template-columns:1.3fr 1fr 1fr;gap:18px;margin:20px 0}.adm-funding-values>div{min-width:0}.adm-funding-values span{display:block;font-size:12px}.adm-funding-values strong{display:block;overflow-wrap:anywhere;font-variant-numeric:tabular-nums;line-height:1.4;font-size:28px;margin:8px 0}.adm-funding-values .adm-funding-empty{font-size:20px}.adm-funding-values .adm-funding-used strong{font-size:34px}.adm-funding-values .adm-funding-used .adm-funding-empty{font-size:20px}.adm-balance-state,.adm-funding-warning,.adm-funding-adjustments,.adm-funding-details{font-size:12px;line-height:1.7;overflow-wrap:anywhere}.adm-balance-state{color:#287459}.adm-balance-state.delayed,.adm-funding-warning{color:#a06418}.adm-funding-basis{display:block;margin-top:12px}.adm-funding-details{margin:16px 0}.adm-funding-details summary{cursor:pointer;font-weight:600}.adm-funding-confirm{margin-top:14px}.adm-funding-link{display:block;font-size:13px;margin-top:12px;color:var(--green,#28553e)}.adm-funding-compact .adm-funding-values{grid-template-columns:1fr 1fr;gap:10px}.adm-funding-compact .adm-funding-used{grid-column:1/-1}.adm-funding-compact .adm-funding-values strong{font-size:19px}.adm-funding-compact .adm-funding-values .adm-funding-used strong{font-size:34px}.adm-funding-compact .adm-funding-values .adm-funding-used .adm-funding-empty{font-size:20px}@media(max-width:600px){.adm-funding-values{grid-template-columns:1fr 1fr}.adm-funding-used{grid-column:1/-1}}
</style>
