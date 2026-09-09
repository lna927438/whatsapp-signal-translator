<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { requireSupabase, supabaseConfigured } from '../lib/supabase'

const emit = defineEmits(['close', 'updated'])
const profile = ref<any>(null)
const editing = ref(false)
const username = ref('')
const email = ref('')
const busy = ref(false)
const message = ref('')
const topupOptions = [100_000, 500_000, 1_000_000]

const formatter = new Intl.NumberFormat('zh-CN')
const remaining = computed(() => Number(profile.value?.remainingCharacters || 0))
const total = computed(() => Number(profile.value?.totalCharacters || 0))
const used = computed(() => Number(profile.value?.usedCharacters || 0))
const usedPercent = computed(() => total.value > 0 ? Math.min(100, Math.round((used.value / total.value) * 100)) : 0)

function formatChars(value: number) { return formatter.format(Math.max(0, Math.floor(Number(value || 0)))) }
function formatDate(value: number) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—' }
function scrollToTopup() { globalThis.document?.getElementById('character-topup')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }

async function reload() {
  profile.value = await window.desktopAPI.getProfile()
  username.value = profile.value?.username || ''
  email.value = profile.value?.email || ''
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
    profile.value = await window.desktopAPI.updateProfile({ username: username.value, email: email.value })
    editing.value = false
    message.value = '账号信息已保存。邮箱修改可能需要按 Supabase 安全策略完成确认。'
    emit('updated', profile.value)
  } catch (error: any) { message.value = error?.message || String(error) }
  finally { busy.value = false }
}

async function topup(amount: number) {
  busy.value = true; message.value = ''
  try {
    profile.value = await window.desktopAPI.topUpCharacters(amount, `字符包 +${formatChars(amount)}`)
    message.value = `开发测试额度已增加 ${formatChars(amount)} 个字符。正式版将改为服务端充值。`
    emit('updated', profile.value)
  } catch (error: any) { message.value = error?.message || String(error) }
  finally { busy.value = false }
}

async function logout() {
  if (busy.value) return
  busy.value = true; message.value = ''
  try {
    if (supabaseConfigured) await requireSupabase().auth.signOut()
    await window.desktopAPI.authSetOnlineSession(null)
    globalThis.location.reload()
  } catch (error: any) { message.value = error?.message || String(error); busy.value = false }
}

onMounted(reload)
</script>

<template>
  <div class="modal-backdrop personal-center-backdrop" @click.self="emit('close')">
    <section class="personal-center-card">
      <header class="personal-center-header"><div><span class="personal-center-kicker">ACCOUNT</span><h2>个人中心</h2><p>在线身份由 Supabase Auth 管理；字符钱包正在迁移到服务端。</p></div><button class="personal-close" @click="emit('close')">×</button></header>
      <div v-if="profile" class="personal-center-body">
        <div class="quota-hero"><div><small>剩余字符数</small><strong>{{ formatChars(remaining) }}</strong><span>{{ profile.planName || '高级套餐' }}</span></div><div class="quota-ring" :style="{ '--quota-used': usedPercent + '%' }"><b>{{ 100 - usedPercent }}%</b><small>剩余</small></div></div>
        <div class="quota-progress"><i :style="{ width: usedPercent + '%' }"></i></div><div class="quota-progress-labels"><span>已用 {{ formatChars(used) }}</span><span>总额度 {{ formatChars(total) }}</span></div>
        <div class="profile-grid"><div class="profile-row"><span>用户名</span><b>{{ profile.username || '未设置' }}</b></div><div class="profile-row"><span>邮箱</span><b>{{ profile.email || '未设置' }}</b></div><div class="profile-row"><span>套餐类型</span><b>{{ profile.planName || '高级套餐' }}</b></div><div class="profile-row"><span>注册时间</span><b>{{ formatDate(profile.registeredAt) }}</b></div></div>
        <div class="personal-actions"><button class="personal-primary" @click="editing = !editing">账号中心</button><button class="personal-secondary" @click="scrollToTopup">充值</button></div>
        <div v-if="editing" class="account-editor"><label>用户名<input v-model="username" placeholder="请输入用户名" maxlength="80" /></label><label>邮箱<input v-model="email" type="email" placeholder="请输入邮箱" maxlength="160" /></label><div class="account-editor-actions"><button class="secondary" @click="editing = false">取消</button><button class="primary" :disabled="busy" @click="saveAccount">{{ busy ? '保存中…' : '保存资料' }}</button></div><small>用户名同步到 Supabase profiles；邮箱由 Supabase Auth 管理。</small></div>
        <div id="character-topup" class="topup-section"><div class="section-title"><div><strong>字符充值</strong><small>按源文本字符数计算</small></div><span>迁移中：当前为本地测试额度</span></div><div class="topup-grid"><button v-for="amount in topupOptions" :key="amount" :disabled="busy" @click="topup(amount)"><b>+{{ formatChars(amount) }}</b><span>字符</span></button></div><p>正式版充值会由 Cloudflare API + Supabase 钱包 + Stripe webhook 完成，客户端不能直接修改余额。</p></div>
        <div class="usage-history"><div class="section-title"><div><strong>字符明细</strong><small>最近 {{ Math.min(profile.ledger?.length || 0, 20) }} 条</small></div></div><div v-if="profile.ledger?.length" class="usage-list"><div v-for="item in profile.ledger.slice(0, 20)" :key="item.id" class="usage-row"><div><b>{{ item.note || (item.type === 'translation' ? '翻译' : '充值') }}</b><small>{{ formatDate(item.createdAt) }}</small></div><strong :class="item.characters >= 0 ? 'plus' : 'minus'">{{ item.characters >= 0 ? '+' : '' }}{{ formatChars(Math.abs(item.characters)) }}</strong></div></div><div v-else class="usage-empty">暂时没有字符使用记录。</div></div>
        <button class="personal-logout" :disabled="busy" @click="logout">退出在线账号</button><p class="personal-logout-note">退出不会清除 WhatsApp 登录状态或本地翻译缓存。</p><p v-if="message" class="personal-message">{{ message }}</p>
      </div>
      <div v-else class="personal-loading">正在读取个人中心…</div>
    </section>
  </div>
</template>
