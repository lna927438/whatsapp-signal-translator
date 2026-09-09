<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

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

function formatChars(value: number) {
  return formatter.format(Math.max(0, Math.floor(Number(value || 0))))
}

function formatDate(value: number) {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

async function reload() {
  profile.value = await window.desktopAPI.getProfile()
  username.value = profile.value?.username || ''
  email.value = profile.value?.email || ''
}

async function saveAccount() {
  busy.value = true
  message.value = ''
  try {
    profile.value = await window.desktopAPI.updateProfile({ username: username.value, email: email.value })
    editing.value = false
    message.value = '账号信息已保存。'
    emit('updated', profile.value)
  } catch (error: any) {
    message.value = error?.message || String(error)
  } finally {
    busy.value = false
  }
}

async function topup(amount: number) {
  busy.value = true
  message.value = ''
  try {
    profile.value = await window.desktopAPI.topUpCharacters(amount, `字符包 +${formatChars(amount)}`)
    message.value = `已增加 ${formatChars(amount)} 个字符额度。`
    emit('updated', profile.value)
  } catch (error: any) {
    message.value = error?.message || String(error)
  } finally {
    busy.value = false
  }
}

onMounted(reload)
</script>

<template>
  <div class="modal-backdrop personal-center-backdrop" @click.self="emit('close')">
    <section class="personal-center-card">
      <header class="personal-center-header">
        <div>
          <span class="personal-center-kicker">ACCOUNT</span>
          <h2>个人中心</h2>
          <p>翻译额度按实际 API 新翻译的源文本字符数扣减；缓存历史翻译不重复扣字符。</p>
        </div>
        <button class="personal-close" @click="emit('close')">×</button>
      </header>

      <div v-if="profile" class="personal-center-body">
        <div class="quota-hero">
          <div>
            <small>剩余字符数</small>
            <strong>{{ formatChars(remaining) }}</strong>
            <span>{{ profile.planName || '高级套餐' }}</span>
          </div>
          <div class="quota-ring" :style="{ '--quota-used': usedPercent + '%' }">
            <b>{{ 100 - usedPercent }}%</b>
            <small>剩余</small>
          </div>
        </div>

        <div class="quota-progress"><i :style="{ width: usedPercent + '%' }"></i></div>
        <div class="quota-progress-labels">
          <span>已用 {{ formatChars(used) }}</span>
          <span>总额度 {{ formatChars(total) }}</span>
        </div>

        <div class="profile-grid">
          <div class="profile-row"><span>用户名</span><b>{{ profile.username || '未设置' }}</b></div>
          <div class="profile-row"><span>邮箱</span><b>{{ profile.email || '未设置' }}</b></div>
          <div class="profile-row"><span>套餐类型</span><b>{{ profile.planName || '高级套餐' }}</b></div>
          <div class="profile-row"><span>注册时间</span><b>{{ formatDate(profile.registeredAt) }}</b></div>
        </div>

        <div class="personal-actions">
          <button class="personal-primary" @click="editing = !editing">账号中心</button>
          <button class="personal-secondary" @click="document.getElementById('character-topup')?.scrollIntoView({ behavior: 'smooth' })">充值</button>
        </div>

        <div v-if="editing" class="account-editor">
          <label>用户名<input v-model="username" placeholder="请输入用户名" maxlength="80" /></label>
          <label>邮箱<input v-model="email" type="email" placeholder="请输入邮箱" maxlength="160" /></label>
          <div class="account-editor-actions">
            <button class="secondary" @click="editing = false">取消</button>
            <button class="primary" :disabled="busy" @click="saveAccount">{{ busy ? '保存中…' : '保存资料' }}</button>
          </div>
          <small>用户名和邮箱只保存在当前电脑，不会写入公开 GitHub 仓库。</small>
        </div>

        <div id="character-topup" class="topup-section">
          <div class="section-title">
            <div><strong>字符充值</strong><small>按源文本字符数计算</small></div>
            <span>当前开发版：本地额度管理</span>
          </div>
          <div class="topup-grid">
            <button v-for="amount in topupOptions" :key="amount" :disabled="busy" @click="topup(amount)">
              <b>+{{ formatChars(amount) }}</b><span>字符</span>
            </button>
          </div>
          <p>缓存命中、历史记录恢复、内置短词词典翻译均不扣字符。只有真正发起新的翻译 API 请求并成功返回时才扣减。</p>
        </div>

        <div class="usage-history">
          <div class="section-title"><div><strong>字符明细</strong><small>最近 {{ Math.min(profile.ledger?.length || 0, 20) }} 条</small></div></div>
          <div v-if="profile.ledger?.length" class="usage-list">
            <div v-for="item in profile.ledger.slice(0, 20)" :key="item.id" class="usage-row">
              <div><b>{{ item.note || (item.type === 'translation' ? '翻译' : '充值') }}</b><small>{{ formatDate(item.createdAt) }}</small></div>
              <strong :class="item.characters >= 0 ? 'plus' : 'minus'">{{ item.characters >= 0 ? '+' : '' }}{{ formatChars(Math.abs(item.characters)) }}</strong>
            </div>
          </div>
          <div v-else class="usage-empty">暂时没有字符使用记录。</div>
        </div>

        <p v-if="message" class="personal-message">{{ message }}</p>
      </div>

      <div v-else class="personal-loading">正在读取个人中心…</div>
    </section>
  </div>
</template>
