<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { requireSupabase, supabaseConfigured } from '../lib/supabase'

const router = useRouter()
const loading = ref(true)
const error = ref('')
const retrying = ref(false)
const retryCount = ref(0)
const user = ref<any>(null)
const profile = ref<any>(null)
const wallet = ref<any>(null)
const usage = ref<any[]>([])
const formatter = new Intl.NumberFormat('zh-CN')

const balance = computed(() => Number(wallet.value?.balance || 0))
const credited = computed(() => Number(wallet.value?.lifetime_credited || 0))
const debited = computed(() => Number(wallet.value?.lifetime_debited || 0))
const total = computed(() => Math.max(credited.value, balance.value + debited.value, 1))
const remainingPct = computed(() => Math.max(0, Math.min(100, Math.round(balance.value / total.value * 100))))

function fmt(value: number) { return formatter.format(Math.max(0, Math.floor(value || 0))) }
function date(value?: string) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—' }
function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)) }
function isJwtFutureError(value: unknown) {
  const text = String((value as any)?.message || value || '').toLowerCase()
  return text.includes('jwt issued at future') || text.includes('pgrst303')
}

async function readCloudData(uid: string) {
  const client = requireSupabase()
  const [profileResult, walletResult, usageResult] = await Promise.all([
    client.from('profiles').select('*').eq('id', uid).single(),
    client.from('wallets').select('*').eq('user_id', uid).single(),
    client.from('translation_usage').select('*').eq('user_id', uid).order('created_at', { ascending: false }).limit(20)
  ])
  if (profileResult.error) throw profileResult.error
  if (walletResult.error) throw walletResult.error
  if (usageResult.error) throw usageResult.error
  return {
    profile: profileResult.data,
    wallet: walletResult.data,
    usage: usageResult.data || []
  }
}

async function load() {
  loading.value = true
  error.value = ''
  retrying.value = false
  retryCount.value = 0
  try {
    if (!supabaseConfigured) throw new Error('网站尚未配置 Supabase。')
    const client = requireSupabase()
    let { data: sessionData } = await client.auth.getSession()
    if (!sessionData.session) { await router.push('/login'); return }
    user.value = sessionData.session.user
    const uid = user.value.id

    const delays = [0, 1500, 3000, 6000]
    let lastError: any = null
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      if (delays[attempt]) {
        retrying.value = true
        retryCount.value = attempt
        await sleep(delays[attempt])
      }
      try {
        const result = await readCloudData(uid)
        profile.value = result.profile
        wallet.value = result.wallet
        usage.value = result.usage
        retrying.value = false
        return
      } catch (e: any) {
        lastError = e
        if (!isJwtFutureError(e)) throw e
        // Supabase/PostgREST occasionally rejects a freshly issued token because
        // the service clock is slightly behind Auth. Refresh once, then retry.
        if (attempt === 1) {
          const refreshed = await client.auth.refreshSession().catch(() => null)
          if (refreshed?.data?.session) {
            sessionData = refreshed.data
            user.value = refreshed.data.session.user
          }
        }
      }
    }
    throw lastError || new Error('云端账户暂时无法读取，请稍后重试。')
  } catch (e: any) {
    if (isJwtFutureError(e)) {
      error.value = 'Supabase 云端时间同步中，刚完成验证的登录令牌暂时被数据库拒绝。请等待 10–30 秒后刷新页面；系统也会自动重试。'
    } else {
      error.value = e?.message || String(e)
    }
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <main class="account-page">
    <section class="account-heading">
      <div><span class="eyebrow">ONLINE ACCOUNT</span><h1>用户中心</h1><p>账号、字符钱包与翻译使用记录都来自 Supabase 云端。</p></div>
      <RouterLink class="ghost-button" to="/download">下载最新版</RouterLink>
    </section>

    <div v-if="loading" class="state-card">{{ retrying ? `云端账户同步中，正在第 ${retryCount + 1} 次重试…` : '正在读取云端账户…' }}</div>
    <div v-else-if="error" class="state-card error">{{ error }}</div>

    <template v-else>
      <section class="wallet-card glass-card">
        <div class="wallet-main">
          <span>云端剩余字符数</span>
          <strong>{{ fmt(balance) }}</strong>
          <em>{{ profile?.plan_code || 'free' }}</em>
        </div>
        <div class="wallet-ring" :style="{ '--remaining': remainingPct + '%' }"><b>{{ remainingPct }}%</b><small>剩余</small></div>
        <div class="wallet-stats"><span>累计使用 <b>{{ fmt(debited) }}</b></span><span>累计入账 <b>{{ fmt(credited) }}</b></span></div>
      </section>

      <section class="account-grid">
        <article class="info-card"><span>用户名</span><b>{{ profile?.username || '未设置' }}</b></article>
        <article class="info-card"><span>邮箱</span><b>{{ user?.email || profile?.email || '—' }}</b></article>
        <article class="info-card"><span>套餐</span><b>{{ profile?.plan_code || 'free' }}</b></article>
        <article class="info-card"><span>账号状态</span><b>{{ profile?.status || 'active' }}</b></article>
        <article class="info-card"><span>注册时间</span><b>{{ date(profile?.created_at) }}</b></article>
        <article class="info-card"><span>云端服务</span><b class="online-dot">● Cloudflare API 已连接</b></article>
      </section>

      <section class="usage-panel">
        <div class="panel-title"><div><span class="eyebrow">USAGE</span><h2>最近翻译消耗</h2></div><span>最近 {{ usage.length }} 条</span></div>
        <div v-if="usage.length" class="usage-table">
          <div class="usage-head"><span>模型</span><span>方向</span><span>时间</span><span>延迟</span><span>字符</span></div>
          <div v-for="item in usage" :key="item.request_id" class="usage-row">
            <span><b>{{ item.model || item.provider }}</b></span>
            <span>{{ item.source_language || 'auto' }} → {{ item.target_language || '—' }}</span>
            <span>{{ date(item.created_at) }}</span>
            <span>{{ item.latency_ms || 0 }} ms</span>
            <span class="minus">-{{ fmt(item.source_characters || 0) }}</span>
          </div>
        </div>
        <div v-else class="usage-empty">暂时没有云端翻译记录。</div>
      </section>

      <section class="plan-panel">
        <div><span class="eyebrow">BILLING</span><h2>套餐与充值</h2><p>支付系统接入后，这里会直接创建订单并为云端钱包充值。</p></div>
        <button class="primary-button" disabled>充值即将开放</button>
      </section>
    </template>
  </main>
</template>
