<script setup lang="ts">
import {onMounted,onUnmounted,ref} from 'vue'
import {request,date,usd,type Row} from './client'
const policy=ref<Row>({}),events=ref<Row[]>([]),busy=ref(false),error=ref(''),checked=ref('')
let active=true,timer:ReturnType<typeof setInterval>|undefined
const names:Record<string,string>={rate_limited:'请求频率保护',cost_limit:'费用达到保护上限',security_paused:'翻译已暂停',mfa_required:'需要管理员二次验证',mfa_step_up:'重要操作需要重新验证',provider_failure:'翻译服务异常',release_guard:'发布检查',backup_check:'备份检查',account_deleted:'账号注销'}
async function refresh(){if(busy.value)return;busy.value=true;error.value='';try{const data=await request<{policy:Row;events:Row[];snapshotAt:string}>('security');if(active){policy.value=data.policy;events.value=data.events;checked.value=data.snapshotAt}}catch(e){if(active)error.value=e instanceof Error?e.message:'安全状态读取失败。'}finally{busy.value=false}}
onMounted(()=>{void refresh();timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh()},30000)})
onUnmounted(()=>{active=false;clearInterval(timer)})
</script>
<template><section class="adm-card"><h2>安全与费用保护</h2><p class="adm-help">保护额度用于阻止异常消耗，不是用户套餐价格。结果未确认的请求会保留费用预留，避免反复请求扩大损失。</p>
  <p v-if="error" class="adm-error" role="alert">{{error}}</p><dl class="adm-status-list"><div><dt>翻译服务</dt><dd>{{policy.enabled===true?'正常，保护已启用':policy.enabled===false?'已安全暂停':'读取中'}}</dd></div><div><dt>每用户每日保护限额</dt><dd>{{usd(policy.user_daily_usd)}}</dd></div><div><dt>全站每日保护限额</dt><dd>{{usd(policy.global_daily_usd)}}</dd></div><div><dt>每用户最大同时翻译数</dt><dd>{{policy.user_concurrency??'读取中'}}</dd></div><div><dt>云端译文保留</dt><dd>{{policy.response_retention_days??'读取中'}} 天</dd></div></dl>
  <p class="adm-help">管理员账号需要验证器。重要操作的验证有效期为 10 分钟。调整保护额度应经过核对，操作日志不包含聊天正文或密钥。</p><button class="adm-button" :disabled="busy" @click="refresh">{{busy?'读取中…':'刷新安全状态'}}</button><p class="adm-help">检查时间：{{date(checked)}}</p>
  <h3>最近安全记录</h3><p v-if="!events.length">当前没有需要显示的安全事件。</p><ul v-else class="adm-security-events"><li v-for="item in events" :key="String(item.id)"><b>{{names[String(item.code)]||'安全事件'}}</b><time>{{date(item.created_at)}}</time></li></ul>
</section></template>
<style scoped>.adm-security-events{list-style:none;padding:0}.adm-security-events li{display:flex;justify-content:space-between;gap:20px;padding:14px 0;border-bottom:1px solid #dbe2d7}.adm-security-events time{color:#627666}</style>
