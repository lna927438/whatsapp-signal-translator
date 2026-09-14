<script setup lang="ts">
import { t, uiLanguage, languageName, uiError } from '../lib/uiLocale'

import { computed, onMounted, onUnmounted, ref } from 'vue'
import { requireSupabase, signOutThisDevice, supabaseConfigured } from '../lib/supabase'
import { cloudApi } from '../lib/cloudApi'

const emit = defineEmits(['close', 'updated'])
const localProfile = ref<any>(null)
const cloudState = ref<any>(null)
const cloudUsage = ref<any[]>([])
const editing = ref(false)
const username = ref('')
const email = ref('')
const busy = ref(false)
const message = ref('')
const cloudError = ref('')
const usageError = ref('')
const syncing = ref(false)
const lastSyncedAt = ref('')
const atomicSnapshot = ref(false)
const reconciliation = ref<any>(null)
let refreshAgain = false
let disposed = false
let revision = 0
let poll: ReturnType<typeof setInterval> | undefined
let unsubscribe: (() => void) | undefined
function invalidate() { revision++; syncing.value = true; if (busy.value) refreshAgain = true; else void reload() }

const formatter = new Intl.NumberFormat(uiLanguage.value)
const remaining = computed(() => Number(cloudState.value?.wallet?.balance || 0))
const credited = computed(() => Number(cloudState.value?.wallet?.lifetime_credited || 0))
const used = computed(() => Number(cloudState.value?.wallet?.lifetime_debited || 0))
const total = computed(() => Math.max(remaining.value + used.value, credited.value, 0))
const usedPercent = computed(() => total.value > 0 ? Math.min(100, Math.round((used.value / total.value) * 100)) : 0)
const profile = computed(() => cloudState.value?.profile || {})
const user = computed(() => cloudState.value?.user || {})

function formatChars(value: number) { return formatter.format(Math.max(0, Math.floor(Number(value || 0)))) }
function formatDate(value: string | number | undefined) {
  if (!value) return '—'
  return new Date(value).toLocaleString(uiLanguage.value, { hour12: false })
}

async function reload() {
  if (busy.value) return
  busy.value = true
  syncing.value = true
  const current = revision
  cloudError.value = ''
  try {
    localProfile.value = (await window.desktopAPI.authStatus())?.user || localProfile.value
    let nextState: any
    let atomic = true
    try { nextState = await cloudApi.snapshot() }
    catch (error: any) {
      if (!/API route not found|404/.test(error.message || '')) throw error
      nextState = await cloudApi.me(); atomic = false
    }
    if (disposed || current !== revision) return
    cloudState.value = nextState
    atomicSnapshot.value = atomic
    reconciliation.value = atomic ? nextState.reconciliation : null
    try {
      const usageResult = atomic ? nextState : await cloudApi.usage()
      if (disposed || current !== revision) return
      if (!Array.isArray(usageResult?.usage)) throw new Error(t('使用记录响应无效'))
      cloudUsage.value = usageResult.usage
      usageError.value = ''
      lastSyncedAt.value = atomic ? new Date(nextState.snapshotAt).toLocaleString(uiLanguage.value) : new Date().toLocaleTimeString()
    } catch { usageError.value = t('使用记录暂未同步，请重新同步后查看。') }
    if (!editing.value) {
      username.value = profile.value?.username || localProfile.value?.username || ''
      email.value = user.value?.email || profile.value?.email || localProfile.value?.email || ''
    }
  } catch (error: any) {
    cloudError.value = error?.message || String(error)
    username.value = localProfile.value?.username || ''
    email.value = localProfile.value?.email || ''
  } finally {
    busy.value = false
    syncing.value = current !== revision
    if (refreshAgain && !disposed) { refreshAgain = false; void reload() }
  }
}

async function saveAccount() {
  busy.value = true; message.value = ''
  try {
    if (supabaseConfigured) {
      const client = requireSupabase()
      const { data: userData } = await client.auth.getUser()
      const userId = userData.user?.id
      if (userId) {
        const { error: profileError } = await client.from('profiles').update({ username: username.value.trim(), display_name: username.value.trim() }).eq('id', userId)
        if (profileError) throw profileError
        if (email.value.trim() && email.value.trim().toLowerCase() !== String(userData.user?.email || '').toLowerCase()) {
          const { error: emailError } = await client.auth.updateUser({ email: email.value.trim().toLowerCase() })
          if (emailError) throw emailError
        }
      }
    }
    await window.desktopAPI.updateProfile({ username: username.value, email: email.value })
    editing.value = false
    message.value = t('账号信息已保存。')
    busy.value = false
    await reload()
    emit('updated', cloudState.value)
  } catch (error: any) { message.value = error?.message || String(error) }
  finally { busy.value = false }
}

async function logout() {
  if (busy.value) return
  busy.value = true; message.value = ''
  try {
    await signOutThisDevice()
  } catch (error: any) {
    message.value = error?.message || String(error)
    busy.value = false
  }
}

onMounted(() => { void reload(); unsubscribe = window.desktopAPI.onBillingChanged(invalidate); window.addEventListener('focus', invalidate); window.addEventListener('online', invalidate); poll = setInterval(() => { if (!busy.value) void reload() }, 5000) })
onUnmounted(() => { disposed = true; unsubscribe?.(); if (poll) clearInterval(poll); window.removeEventListener('focus', invalidate); window.removeEventListener('online', invalidate) })
</script>

<template>
  <div class="modal-backdrop personal-center-backdrop" @click.self="emit('close')">
    <section class="personal-center-card">
      <header class="personal-center-header">
        <div><span class="personal-center-kicker">HELLODOG ACCOUNT</span><h2>{{ t('个人中心') }}</h2><p>{{ t('你的 HelloDog 账号、字符余额和翻译使用记录。') }}</p></div>
        <div style="display:flex;gap:8px;align-items:center"><button class="personal-logout" :disabled="busy" @click="logout">{{ t('退出登录') }}</button><button class="personal-close" @click="emit('close')">×</button></div>
      </header>

      <div v-if="cloudState || localProfile || cloudError" class="personal-center-body">
        <div v-if="cloudError" class="api-message error">{{ t('账户暂未同步：') }}{{ cloudError }} <button :disabled="busy" @click="reload">{{ t('重新同步') }}</button></div>

        <div class="quota-hero">
          <div><small>{{ (cloudError || syncing) ? t('上次确认的剩余字符数（待同步）') : t('云端剩余字符数') }}</small><strong>{{ cloudState ? formatChars(remaining) : t('未同步') }}</strong><span>{{ profile?.plan_code || '—' }}</span></div>
          <div class="quota-ring" :style="{ '--quota-used': usedPercent + '%' }"><b>{{ cloudState ? (total > 0 ? 100 - usedPercent : 0) + '%' : '—' }}</b><small>{{ t('剩余') }}</small></div>
        </div>
        <div class="quota-progress"><i :style="{ width: usedPercent + '%' }"></i></div>
        <div class="quota-progress-labels"><span>{{ t('累计使用 ') }}{{ cloudState ? formatChars(used) : t('未同步') }}</span><span>{{ t('累计入账 ') }}{{ cloudState ? formatChars(credited) : t('未同步') }}</span></div>

        <div class="profile-grid">
          <div class="profile-row"><span>{{ t('用户名') }}</span><b>{{ profile?.username || localProfile?.username || t('未设置') }}</b></div>
          <div class="profile-row"><span>{{ t('邮箱') }}</span><b>{{ user?.email || profile?.email || localProfile?.email || t('未设置') }}</b></div>
          <div class="profile-row"><span>{{ t('套餐类型') }}</span><b>{{ profile?.plan_code || t('未同步') }}</b></div>
          <div class="profile-row"><span>{{ t('账号状态') }}</span><b>{{ profile?.status || t('未同步') }}</b></div>
          <div class="profile-row"><span>{{ t('注册时间') }}</span><b>{{ formatDate(profile?.created_at) }}</b></div>
          <div class="profile-row"><span>{{ t('云端服务') }}</span><b>{{ cloudError ? t('等待重新连接') : syncing ? t('同步中') : cloudState ? t('已同步') : t('同步中') }}</b></div>
        </div>

        <div class="personal-actions"><button class="personal-primary" @click="editing = !editing">{{ t('账号中心') }}</button><button class="personal-secondary" disabled :title="t('支付系统接入后开放')">{{ t('充值即将开放') }}</button></div>

        <div v-if="editing" class="account-editor">
          <label>{{ t('用户名') }}<input v-model="username" :placeholder="t('请输入用户名')" maxlength="80" /></label>
          <label>{{ t('邮箱') }}<input v-model="email" type="email" :placeholder="t('请输入邮箱')" maxlength="160" /></label>
          <div class="account-editor-actions"><button class="secondary" @click="editing = false">{{ t('取消') }}</button><button class="primary" :disabled="busy" @click="saveAccount">{{ busy ? t('保存中…') : t('保存资料') }}</button></div>
          <small>{{ t('修改邮箱后，请根据验证邮件完成确认。') }}</small>
        </div>

        <div class="usage-history">
          <p>{{ syncing ? t('正在同步云端余额与使用记录…') : lastSyncedAt ? t('上次同步：') + lastSyncedAt : t('等待云端同步') }}</p>
          <p v-if="usageError" class="api-message error">{{ usageError }}</p>
          <p v-if="!atomicSnapshot">{{ t('服务端尚未提供统一对账快照。余额与记录为分别读取，暂未确认账本一致。') }}</p>
          <p v-else>{{ reconciliation.duplicateDebits === 0 && reconciliation.mismatchedRequests === 0 && reconciliation.translationDebit === reconciliation.usageCharacters && cloudState.wallet.balance === cloudState.wallet.lifetime_credited - cloudState.wallet.lifetime_debited ? t('此快照的翻译账本与使用记录一致，逐笔字符数相符，未发现重复扣费编号。') : t('账本与使用记录存在差异，请保留请求编号核对。') }}{{ t(' 翻译扣费 ') }}{{ reconciliation.translationDebit }}{{ t('，使用记录 ') }}{{ reconciliation.usageCharacters }}{{ t(' 字符。') }}</p>
          <div class="section-title"><div><strong>{{ t('最近云端翻译消耗') }}</strong><small>{{ t('最近 ') }}{{ cloudUsage.length }}{{ t(' 条') }}</small></div></div>
          <div v-if="cloudUsage.length" class="usage-list">
            <div v-for="item in cloudUsage" :key="item.request_id" class="usage-row">
              <div><b>{{ item.model || item.provider || t('云端翻译') }}</b><small>{{ formatDate(item.created_at) }}{{ t(' · 原文 ') }}{{ item.source_characters }}{{ t(' 字符') }}</small><code style="overflow-wrap:anywhere">{{ item.request_id }}</code></div>
              <strong class="minus">-{{ formatChars(item.source_characters || 0) }}</strong>
            </div>
          </div>
          <div v-else-if="!usageError" class="usage-empty">{{ t('暂时没有云端翻译使用记录。') }}</div>
        </div>

        <button class="personal-logout" :disabled="busy" @click="logout">{{ t('退出当前账号') }}</button>
        <p class="personal-logout-note">{{ t('退出账号不会清除 WhatsApp / Signal 登录状态，也不会删除本地历史翻译缓存。字符余额保存在云端。') }}</p>
        <p v-if="message" class="personal-message">{{ uiError(message) }}</p>
      </div>

      <div v-else class="personal-loading">{{ t('正在读取云端个人中心…') }}</div>
    </section>
  </div>
</template>
