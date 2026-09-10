<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
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

const formatter = new Intl.NumberFormat('zh-CN')
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
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

async function reload() {
  if (busy.value) return
  busy.value = true
  cloudError.value = ''
  try {
    localProfile.value = (await window.desktopAPI.authStatus())?.user || localProfile.value
    cloudState.value = await cloudApi.me()
    try {
      const usageResult = await cloudApi.usage()
      cloudUsage.value = Array.isArray(usageResult?.usage) ? usageResult.usage : []
      usageError.value = ''
    } catch { usageError.value = '使用记录暂未同步，请重新同步后查看。' }
    username.value = profile.value?.username || localProfile.value?.username || ''
    email.value = user.value?.email || profile.value?.email || localProfile.value?.email || ''
  } catch (error: any) {
    cloudError.value = error?.message || String(error)
    username.value = localProfile.value?.username || ''
    email.value = localProfile.value?.email || ''
  } finally {
    busy.value = false
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
    message.value = '账号信息已保存。'
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

onMounted(reload)
</script>

<template>
  <div class="modal-backdrop personal-center-backdrop" @click.self="emit('close')">
    <section class="personal-center-card">
      <header class="personal-center-header">
        <div><span class="personal-center-kicker">HELLODOG ACCOUNT</span><h2>个人中心</h2><p>你的 HelloDog 账号、字符余额和翻译使用记录。</p></div>
        <div style="display:flex;gap:8px;align-items:center"><button class="personal-logout" :disabled="busy" @click="logout">退出登录</button><button class="personal-close" @click="emit('close')">×</button></div>
      </header>

      <div v-if="cloudState || localProfile || cloudError" class="personal-center-body">
        <div v-if="cloudError" class="api-message error">账户暂未同步：{{ cloudError }} <button :disabled="busy" @click="reload">重新同步</button></div>

        <div class="quota-hero">
          <div><small>{{ cloudError ? '上次同步的剩余字符数' : '云端剩余字符数' }}</small><strong>{{ cloudState ? formatChars(remaining) : '未同步' }}</strong><span>{{ profile?.plan_code || '—' }}</span></div>
          <div class="quota-ring" :style="{ '--quota-used': usedPercent + '%' }"><b>{{ cloudState ? (total > 0 ? 100 - usedPercent : 0) + '%' : '—' }}</b><small>剩余</small></div>
        </div>
        <div class="quota-progress"><i :style="{ width: usedPercent + '%' }"></i></div>
        <div class="quota-progress-labels"><span>累计使用 {{ cloudState ? formatChars(used) : '未同步' }}</span><span>累计入账 {{ cloudState ? formatChars(credited) : '未同步' }}</span></div>

        <div class="profile-grid">
          <div class="profile-row"><span>用户名</span><b>{{ profile?.username || localProfile?.username || '未设置' }}</b></div>
          <div class="profile-row"><span>邮箱</span><b>{{ user?.email || profile?.email || localProfile?.email || '未设置' }}</b></div>
          <div class="profile-row"><span>套餐类型</span><b>{{ profile?.plan_code || '未同步' }}</b></div>
          <div class="profile-row"><span>账号状态</span><b>{{ profile?.status || '未同步' }}</b></div>
          <div class="profile-row"><span>注册时间</span><b>{{ formatDate(profile?.created_at) }}</b></div>
          <div class="profile-row"><span>云端服务</span><b>{{ cloudError ? '等待重新连接' : cloudState ? '已同步' : '同步中' }}</b></div>
        </div>

        <div class="personal-actions"><button class="personal-primary" @click="editing = !editing">账号中心</button><button class="personal-secondary" disabled title="支付系统接入后开放">充值即将开放</button></div>

        <div v-if="editing" class="account-editor">
          <label>用户名<input v-model="username" placeholder="请输入用户名" maxlength="80" /></label>
          <label>邮箱<input v-model="email" type="email" placeholder="请输入邮箱" maxlength="160" /></label>
          <div class="account-editor-actions"><button class="secondary" @click="editing = false">取消</button><button class="primary" :disabled="busy" @click="saveAccount">{{ busy ? '保存中…' : '保存资料' }}</button></div>
          <small>修改邮箱后，请根据验证邮件完成确认。</small>
        </div>

        <div class="usage-history">
          <p v-if="usageError" class="api-message error">{{ usageError }}</p>
          <div class="section-title"><div><strong>最近云端翻译消耗</strong><small>最近 {{ Math.min(cloudUsage.length, 50) }} 条</small></div></div>
          <div v-if="cloudUsage.length" class="usage-list">
            <div v-for="item in cloudUsage" :key="item.request_id" class="usage-row">
              <div><b>{{ item.model || item.provider || '云端翻译' }}</b><small>{{ formatDate(item.created_at) }} · {{ item.latency_ms || 0 }} ms</small></div>
              <strong class="minus">-{{ formatChars(item.source_characters || 0) }}</strong>
            </div>
          </div>
          <div v-else-if="!usageError" class="usage-empty">暂时没有云端翻译使用记录。</div>
        </div>

        <button class="personal-logout" :disabled="busy" @click="logout">退出当前账号</button>
        <p class="personal-logout-note">退出账号不会清除 WhatsApp / Signal 登录状态，也不会删除本地历史翻译缓存。字符余额保存在云端。</p>
        <p v-if="message" class="personal-message">{{ message }}</p>
      </div>

      <div v-else class="personal-loading">正在读取云端个人中心…</div>
    </section>
  </div>
</template>
