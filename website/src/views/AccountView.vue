<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { apiBase, requireSupabase, supabaseConfigured } from '../lib/supabase'

const router = useRouter()
const loading = ref(true)
const error = ref('')
const user = ref<any>(null)
const snapshot = ref<any>(null)
const profile = computed(() => snapshot.value?.profile)
const wallet = computed(() => snapshot.value?.wallet)
const usage = computed<any[]>(() => snapshot.value?.usage || [])
const formatter = new Intl.NumberFormat('zh-CN')
let disposed=false, generation=0, owner='', busy=false
let abort:AbortController|undefined, poll:ReturnType<typeof setInterval>|undefined, queued:ReturnType<typeof setTimeout>|undefined, unsubscribe:(()=>void)|undefined

const balance = computed(() => Number(wallet.value?.balance || 0))
const credited = computed(() => Number(wallet.value?.lifetime_credited || 0))
const debited = computed(() => Number(wallet.value?.lifetime_debited || 0))
const total = computed(() => Math.max(credited.value, balance.value + debited.value, 1))
const remainingPct = computed(() => Math.max(0, Math.min(100, Math.round(balance.value / total.value * 100))))

function fmt(value: number) { return formatter.format(Math.max(0, Math.floor(value || 0))) }
function date(value?: string) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—' }

class AccountReadError extends Error { constructor(message:string,readonly status:number){super(message)} }
async function apiGet(accessToken: string, signal:AbortSignal) {
  const response = await fetch(`${apiBase}/api/account-snapshot`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json'
    },
    cache: 'no-store',
    signal: AbortSignal.any([signal,AbortSignal.timeout(15000)])
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = String(payload?.message || payload?.error || `云端请求失败 (${response.status})`)
    throw new AccountReadError(message,response.status)
  }
  return payload
}

function checkedSnapshot(value:any,expectedOwner:string){
  if(value?.user?.id!==expectedOwner || value?.profile?.id!==expectedOwner || (value?.wallet?.user_id&&value.wallet.user_id!==expectedOwner))throw new Error('账户快照身份不匹配，请重新同步。')
  for(const key of ['balance','lifetime_debited','lifetime_credited'])if(!Number.isSafeInteger(value.wallet?.[key])||value.wallet[key]<0)throw new Error('云端字符数据未通过校验，请重新同步。')
  if(!Array.isArray(value.usage)||!Array.isArray(value.ledger)||!Number.isFinite(Date.parse(value.snapshotAt)))throw new Error('账户快照未通过校验，请重新同步。')
  for(const item of value.usage)if(typeof item?.request_id!=='string'||!Number.isSafeInteger(item.source_characters)||item.source_characters<1)throw new Error('使用记录未通过校验，请重新同步。')
  for(const key of ['translationDebit','usageCharacters','duplicateDebits','mismatchedRequests'])if(!Number.isSafeInteger(value.reconciliation?.[key])||value.reconciliation[key]<0)throw new Error('对账汇总未通过校验，请重新同步。')
  if(snapshot.value&&Date.parse(value.snapshotAt)<Date.parse(snapshot.value.snapshotAt))throw new Error('账户数据尚未更新，保留上次快照。')
  return value
}
function queueLoad(){
 if(disposed||queued)return
 queued=setTimeout(()=>{queued=undefined;if(!disposed)void load()},0)
}
function clearIdentity(){
 ++generation;abort?.abort();busy=false;loading.value=false;snapshot.value=null;user.value=null;owner='';error.value=''
}
async function load() {
  if(disposed||busy)return
  busy=true
  const version=++generation,controller=new AbortController();abort=controller
  const current=()=>!disposed&&generation===version
  loading.value = true
  try {
    if (!supabaseConfigured) throw new Error('网站尚未配置 Supabase。')
    const client = requireSupabase()
    const { data: sessionData,error:sessionError } = await client.auth.getSession()
    if(!current())return
    if(sessionError)throw sessionError
    if (!sessionData.session) { clearIdentity();await router.replace('/login');return }
    const session=sessionData.session,requestedOwner=session.user.id
    if(owner!==requestedOwner){snapshot.value=null;owner=requestedOwner}
    user.value=session.user
    let payload:any
    try {
      payload=await apiGet(session.access_token,controller.signal)
    } catch (firstError) {
      if(!current())return
      if(!(firstError instanceof AccountReadError)||firstError.status!==401)throw firstError
      const refreshed=await client.auth.refreshSession()
      if(!current())return
      if(refreshed.error||!refreshed.data.session)throw new AccountReadError('登录状态已失效，请重新登录。',401)
      if(refreshed.data.session.user.id!==requestedOwner){clearIdentity();queueLoad();return}
      payload=await apiGet(refreshed.data.session.access_token,controller.signal)
    }
    if(!current()||owner!==requestedOwner)return
    snapshot.value=checkedSnapshot(payload,requestedOwner);error.value=''
  } catch (e: any) {
    if(!current())return
    if(e instanceof AccountReadError&&[401,403].includes(e.status)){snapshot.value=null;user.value=null}
    error.value = e?.message || String(e)
  } finally {
    if(current()){loading.value=false;busy=false;abort=undefined}
  }
}

const visibleRefresh=()=>{if(document.visibilityState!=='hidden')void load()}
onMounted(()=>{
 if(supabaseConfigured){
  const {data}=requireSupabase().auth.onAuthStateChange((_event,session)=>{
   if(disposed)return
   const nextOwner=session?.user.id||''
   if(nextOwner!==owner){
    clearIdentity();owner=nextOwner;user.value=session?.user||null
    if(!nextOwner){void router.replace('/login');return}
    loading.value=true;queueLoad()
   }
  })
  unsubscribe=()=>data.subscription.unsubscribe()
 }
 void load();poll=setInterval(visibleRefresh,5000)
 document.addEventListener('visibilitychange',visibleRefresh);window.addEventListener('online',visibleRefresh)
})
onUnmounted(()=>{
 disposed=true;++generation;abort?.abort();if(poll)clearInterval(poll);if(queued)clearTimeout(queued);unsubscribe?.()
 document.removeEventListener('visibilitychange',visibleRefresh);window.removeEventListener('online',visibleRefresh)
 snapshot.value=null;user.value=null
})
</script>

<template>
  <main class="account-page">
    <section class="account-heading">
      <div><span class="eyebrow">HELLODOG ACCOUNT</span><h1>用户中心</h1><p>管理你的 HelloDog 账号、字符余额与翻译使用记录。</p></div>
      <RouterLink class="ghost-button" to="/download">下载最新版</RouterLink>
    </section>

    <div v-if="loading&&!snapshot" class="state-card">正在读取 HelloDog 云端账户…</div>
    <div v-if="error" class="state-card error" role="status">{{ error }} <span v-if="snapshot">保留上次同步数据，当前显示可能过期。</span> <button class="ghost-button" :disabled="loading" @click="load">重新加载</button></div>

    <template v-if="snapshot">
      <section class="wallet-card glass-card">
        <div class="wallet-main">
          <span>云端剩余字符数</span>
          <strong>{{ fmt(balance) }}</strong>
          <em>字符额度</em>
        </div>
        <div class="wallet-ring" :style="{ '--remaining': remainingPct + '%' }"><b>{{ remainingPct }}%</b><small>剩余</small></div>
        <div class="wallet-stats"><span>累计使用 <b>{{ fmt(debited) }}</b></span><span>累计入账 <b>{{ fmt(credited) }}</b></span></div>
      </section>

      <section class="account-grid">
        <article class="info-card"><span>用户名</span><b>{{ profile?.username || '未设置' }}</b></article>
        <article class="info-card"><span>邮箱</span><b>{{ user?.email || profile?.email || '—' }}</b></article>
        <article class="info-card"><span>额度方式</span><b>管理员添加</b></article>
        <article class="info-card"><span>账号状态</span><b>{{ profile?.status || 'active' }}</b></article>
        <article class="info-card"><span>注册时间</span><b>{{ date(profile?.created_at) }}</b></article>
        <article class="info-card"><span>云端服务</span><b :class="{'online-dot':!error}">{{error?'等待重新同步':loading?'正在同步…':'● 本次数据已同步'}}</b><small>同步于 {{date(snapshot.snapshotAt)}} · 页面可见时每 5 秒刷新</small></article>
      </section>

      <section class="usage-panel">
        <div class="panel-title"><div><span class="eyebrow">USAGE</span><h2>最近翻译消耗</h2></div><span>最近 {{ usage.length }} 条</span></div>
        <div v-if="usage.length" class="usage-table">
          <div class="usage-head"><span>模型</span><span>方向</span><span>时间</span><span>延迟</span><span>字符</span></div>
          <div v-for="item in usage" :key="item.request_id" class="usage-row">
            <span><b>{{ item.model || item.provider }}</b></span>
            <span>{{item.source_language||item.target_language?(item.source_language||'auto')+' → '+(item.target_language||'—'):'未记录'}}</span>
            <span>{{ date(item.created_at) }}</span>
            <span>{{ item.latency_ms || 0 }} ms</span>
            <span class="minus">-{{ fmt(item.source_characters || 0) }}</span>
          </div>
        </div>
        <div v-else class="usage-empty">暂时没有云端翻译记录。</div>
      </section>

      <section class="plan-panel">
        <div><span class="eyebrow">BILLING</span><h2>字符额度</h2><p>需要增加字符时，请联系管理员。余额与客户端共用，成功翻译后按原文字符扣减。</p></div>
        <button class="ghost-button" :disabled="loading" @click="load">{{loading?'正在刷新…':'刷新字符余额'}}</button>
      </section>
    </template>
  </main>
</template>
