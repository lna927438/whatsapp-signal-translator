<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import SettingsPanel from './components/SettingsPanel.vue'
import PersonalCenter from './components/PersonalCenter.vue'
import SignalView from './components/SignalView.vue'

type ContactPreference = { language: string; name?: string; updatedAt: number; source?: 'manual'|'auto' }
type Account = {
  id: string
  platform: 'whatsapp'|'signal'
  label: string
  signalAccount?: string
  localLanguage?: string
  targetLanguage?: string
  receiveAutoTranslate?: boolean
  sendAutoTranslate?: boolean
  blockChineseSend?: boolean
  groupTranslate?: boolean
  fontSize?: number
  translationColor?: string
  contactLanguages?: Record<string, ContactPreference>
}

type LiveStatus = { state: 'ready'|'working'|'success'|'error'; message: string; at?: number }
type ConversationInfo = { id: string; name?: string }

const accounts = ref<Account[]>([])
const selected = ref<Account | null>(null)
const showSettings = ref(false)
const showProfile = ref(false)
const error = ref('')
const settings = ref<any>(null)
const profile = ref<any>(null)
const languages = ref<any[]>([])
const liveStatuses = ref<Record<string, LiveStatus>>({})
const conversations = ref<Record<string, ConversationInfo>>({})
const metrics = ref<any>({ totalRequests: 0, providerCalls: 0, cacheHits: 0, dedupHits: 0, activeRequests: 0, queueDepth: 0, lastLatencyMs: 0, averageLatencyMs: 0 })
const controlFeedback = ref<{ state: 'idle'|'saving'|'saved'|'error'; message: string }>({ state: 'idle', message: '' })
let feedbackTimer: ReturnType<typeof setTimeout> | undefined
let metricsTimer: ReturnType<typeof setInterval> | undefined

const selectedIsSignal = computed(() => selected.value?.platform === 'signal')
const selectedConversation = computed(() => selected.value?.id ? conversations.value[selected.value.id] : undefined)
const contactPreference = computed(() => {
  const conversationId = selectedConversation.value?.id
  return conversationId && selected.value?.contactLanguages ? selected.value.contactLanguages[conversationId] : undefined
})
const localLanguage = computed(() => selected.value?.localLanguage || settings.value?.localLanguage || 'zh-CN')
const targetLanguage = computed(() => contactPreference.value?.language || selected.value?.targetLanguage || settings.value?.targetLanguage || 'en-US')
const receiveAutoTranslate = computed(() => selected.value?.receiveAutoTranslate ?? settings.value?.receiveAutoTranslate ?? true)
const sendAutoTranslate = computed(() => selected.value?.sendAutoTranslate ?? settings.value?.sendAutoTranslate ?? true)
const blockChineseSend = computed(() => selected.value?.blockChineseSend ?? settings.value?.blockChineseSend ?? true)
const groupTranslate = computed(() => selected.value?.groupTranslate ?? false)
const fontSize = computed(() => Number(selected.value?.fontSize || settings.value?.fontSize || 13))
const translationColor = computed(() => selected.value?.translationColor || settings.value?.translationColor || '#c8d4e4')
const apiConfigured = computed(() => {
  const provider = settings.value?.provider
  if (provider === 'openai') return Boolean(String(settings.value?.openaiApiKey || '').trim())
  if (provider === 'deepl') return Boolean(String(settings.value?.deeplApiKey || '').trim())
  if (provider === 'google') return Boolean(String(settings.value?.googleApiKey || '').trim())
  return false
})
const channelName = computed(() => {
  if (settings.value?.provider === 'openai') return settings.value?.openaiModel === 'gpt-5.6-luna' ? 'GPT-5.6 LUNA' : String(settings.value?.openaiModel || 'OpenAI')
  if (settings.value?.provider === 'deepl') return 'DeepL'
  return 'Google Translate'
})
const serverName = computed(() => {
  if (settings.value?.provider === 'openai') return 'OpenAI API'
  if (settings.value?.provider === 'deepl') return 'DeepL API'
  return 'Google API'
})
const selectedLiveStatus = computed<LiveStatus>(() => {
  if (!apiConfigured.value) return { state: 'error', message: 'API 密钥未配置' }
  if (Number(profile.value?.remainingCharacters || 0) <= 0) return { state: 'error', message: '字符额度已用完' }
  if (selected.value?.id && liveStatuses.value[selected.value.id]) return liveStatuses.value[selected.value.id]
  return { state: 'ready', message: selected.value?.platform === 'signal' ? 'Signal 翻译就绪' : '翻译器就绪' }
})
const metricLabel = computed(() => {
  const delay = Number(metrics.value?.lastLatencyMs || 0)
  const queue = Number(metrics.value?.queueDepth || 0)
  const hits = Number(metrics.value?.cacheHits || 0) + Number(metrics.value?.dedupHits || 0)
  return `延迟 ${delay} ms · 队列 ${queue} · 缓存 ${hits}`
})
const contactLabel = computed(() => {
  const conversation = selectedConversation.value
  if (!conversation?.id) return ''
  const source = contactPreference.value?.source === 'manual' ? '手动' : contactPreference.value?.source === 'auto' ? '自动识别' : '账号默认'
  return `${conversation.name || '当前联系人'} · ${source}`
})
const remainingCharsLabel = computed(() => new Intl.NumberFormat('zh-CN').format(Math.max(0, Number(profile.value?.remainingCharacters || 0))))
const quotaLow = computed(() => {
  const total = Number(profile.value?.totalCharacters || 0)
  const remaining = Number(profile.value?.remainingCharacters || 0)
  return total > 0 && remaining / total <= 0.1
})

async function reload() {
  accounts.value = await window.desktopAPI.listAccounts()
  if (selected.value) {
    const current = accounts.value.find((item) => item.id === selected.value?.id)
    if (current) selected.value = current
  }
}

async function reloadSettings() {
  settings.value = await window.desktopAPI.getSettings()
  if (!languages.value.length) languages.value = await window.desktopAPI.getLanguages()
}

async function reloadProfile() {
  try { profile.value = await window.desktopAPI.getProfile() } catch { /* ignore transient profile read errors */ }
}

async function reloadMetrics() {
  try { metrics.value = await window.desktopAPI.getTranslationMetrics() } catch { /* ignore transient UI metric errors */ }
  await reloadProfile()
}

async function addWhatsApp() {
  const account = await window.desktopAPI.addAccount({ platform: 'whatsapp' })
  await reload()
  await select(account)
}

async function addSignalRecord(signalAccount?: string) {
  const account = await window.desktopAPI.addAccount({ platform: 'signal', signalAccount })
  await reload()
  await select(account)
}

async function select(account: Account) {
  selected.value = account
  controlFeedback.value = { state: 'idle', message: '' }
  await window.desktopAPI.focusPlatform({ platform: account.platform, accountId: account.id })
}

async function remove(account: Account) {
  await window.desktopAPI.removeAccount(account.id)
  if (selected.value?.id === account.id) {
    selected.value = null
    await window.desktopAPI.focusPlatform({ platform: 'signal' })
  }
  await reload()
}

function setFeedback(state: 'idle'|'saving'|'saved'|'error', message: string) {
  controlFeedback.value = { state, message }
  if (feedbackTimer) clearTimeout(feedbackTimer)
  if (state === 'saved') feedbackTimer = setTimeout(() => { controlFeedback.value = { state: 'idle', message: '' } }, 1800)
}

async function patchSelected(patch: Record<string, unknown>) {
  if (!selected.value) return
  setFeedback('saving', '正在保存…')
  try {
    const updated = await window.desktopAPI.updateAccount(selected.value.id, patch)
    if (!updated) throw new Error('保存失败')
    selected.value = updated
    const index = accounts.value.findIndex((item) => item.id === updated.id)
    if (index >= 0) accounts.value[index] = updated
    setFeedback('saved', '设置已保存')
  } catch (e: any) {
    setFeedback('error', e?.message || '设置保存失败')
  }
}

function setStringField(field: string, event: Event) {
  const value = (event.target as HTMLSelectElement | HTMLInputElement).value
  void patchSelected({ [field]: value })
}

function setNumberField(field: string, event: Event) {
  const value = Number((event.target as HTMLSelectElement).value)
  void patchSelected({ [field]: value })
}

async function setTargetLanguage(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  const account = selected.value
  const conversation = selectedConversation.value
  if (account?.platform === 'whatsapp' && conversation?.id) {
    setFeedback('saving', '正在保存联系人语言…')
    try {
      const updated = await window.desktopAPI.setContactLanguage(account.id, conversation.id, value, conversation.name)
      if (updated) {
        selected.value = updated
        const index = accounts.value.findIndex((item) => item.id === updated.id)
        if (index >= 0) accounts.value[index] = updated
      }
      setFeedback('saved', '联系人语言已保存')
    } catch (e: any) {
      setFeedback('error', e?.message || '联系人语言保存失败')
    }
    return
  }
  await patchSelected({ targetLanguage: value })
}

async function openSettings() {
  await window.desktopAPI.setOverlayOpen(true)
  showSettings.value = true
}

async function closeSettings() {
  showSettings.value = false
  await reloadSettings()
  await window.desktopAPI.setOverlayOpen(false)
}

async function openProfile() {
  await window.desktopAPI.setOverlayOpen(true)
  await reloadProfile()
  showProfile.value = true
}

async function closeProfile() {
  showProfile.value = false
  await reloadProfile()
  await window.desktopAPI.setOverlayOpen(false)
}

function onProfileUpdated(next: any) {
  profile.value = next
}

onMounted(async () => {
  await Promise.all([reload(), reloadSettings(), reloadMetrics()])
  metricsTimer = setInterval(() => { void reloadMetrics() }, 1500)
  window.desktopAPI.onWhatsAppConversation((info: any) => {
    if (!info?.accountId || !info?.conversationId) return
    conversations.value = { ...conversations.value, [info.accountId]: { id: info.conversationId, name: info.conversationName } }
  })
  window.desktopAPI.onContactLanguage(() => { void reload() })
  window.desktopAPI.onTranslatorStatus((status: any) => {
    if (!status?.accountId) return
    liveStatuses.value = {
      ...liveStatuses.value,
      [status.accountId]: {
        state: status.state || 'ready',
        message: status.message || '翻译器就绪',
        at: status.at || Date.now()
      }
    }
  })
  window.desktopAPI.onTranslatorError((message: string) => {
    error.value = message
    setTimeout(() => error.value = '', 6500)
  })
})

onUnmounted(() => {
  if (metricsTimer) clearInterval(metricsTimer)
  if (feedbackTimer) clearTimeout(feedbackTimer)
})
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark">译</div><div><b>实时翻译器</b><small>WhatsApp + Signal</small></div></div>
      <button class="add wa" @click="addWhatsApp">＋ 添加 WhatsApp</button>
      <button class="add signal" @click="addSignalRecord()">＋ 添加 Signal</button>
      <div class="account-list">
        <button v-for="account in accounts" :key="account.id" class="account" :class="{ active: selected?.id===account.id }" @click="select(account)">
          <span class="dot" :class="account.platform"></span><span class="account-label">{{ account.label }}</span><span class="close" title="删除账号" @click.stop="remove(account)">×</span>
        </button>
      </div>
      <div class="sidebar-bottom">
        <button class="profile-btn" @click="openProfile"><span>👤 个人中心</span><small>剩余 {{ remainingCharsLabel }} 字符</small></button>
        <button class="settings-btn" @click="openSettings">⚙ 设置</button>
      </div>
    </aside>

    <header v-if="selected" class="account-toolbar">
      <div class="account-control-row">
        <label class="check-label" title="开启后自动把对方消息翻译成我的语言">
          <input type="checkbox" :checked="receiveAutoTranslate" @change="patchSelected({ receiveAutoTranslate: !receiveAutoTranslate })" />
          <span>对方的语言</span>
        </label>
        <select :value="targetLanguage" @change="setTargetLanguage">
          <option v-for="language in languages.filter(x => x.code !== 'auto')" :key="language.code" :value="language.code">{{ language.zhName || language.name }}</option>
        </select>

        <span class="control-name">翻译通道</span>
        <select class="channel-select" disabled><option>{{ channelName }}</option></select>

        <span class="control-name">字号大小</span>
        <select class="size-select" :value="fontSize" @change="setNumberField('fontSize', $event)">
          <option v-for="size in [12,13,14,15,16,18]" :key="size" :value="size">{{ size }} px</option>
        </select>

        <span class="control-name">群组翻译</span>
        <button class="mini-switch" :class="{ on: groupTranslate }" :title="groupTranslate ? '群组消息自动翻译已开启' : '群组消息自动翻译已关闭'" @click="patchSelected({ groupTranslate: !groupTranslate })"><span></span></button>

        <button class="toolbar-settings" @click="openSettings">翻译设置</button>
      </div>

      <div class="account-control-row second-row">
        <label class="check-label" title="开启后中文输入会先翻译成对方语言再发送">
          <input type="checkbox" :checked="sendAutoTranslate" @change="patchSelected({ sendAutoTranslate: !sendAutoTranslate })" />
          <span>自己的语言</span>
        </label>
        <select :value="localLanguage" @change="setStringField('localLanguage', $event)">
          <option v-for="language in languages.filter(x => x.code !== 'auto')" :key="language.code" :value="language.code">{{ language.zhName || language.name }}</option>
        </select>

        <span class="control-name">翻译服务器</span>
        <div class="server-box"><b>{{ serverName }}</b><em :class="{ ready: apiConfigured }">{{ apiConfigured ? '密钥已配置' : '未配置' }}</em></div>

        <span class="control-name">字体颜色</span>
        <div class="color-box">
          <input type="color" :value="translationColor" @change="setStringField('translationColor', $event)" />
          <code>{{ translationColor }}</code>
        </div>

        <span class="control-name">禁止中文</span>
        <button class="mini-switch" :class="{ on: blockChineseSend }" :title="blockChineseSend ? '中文原文禁止直接发送' : '允许直接发送中文'" @click="patchSelected({ blockChineseSend: !blockChineseSend })"><span></span></button>

        <div class="live-status" :class="selectedLiveStatus.state" :title="selectedLiveStatus.message"><i></i><span>{{ selectedLiveStatus.message }}</span></div>
        <span class="quota-badge" :class="{ low: quotaLow }" title="只有新的 API 翻译成功后才扣字符；缓存和历史恢复不扣字符">余 {{ remainingCharsLabel }} 字符</span>
        <span class="metric-badge" :title="`累计请求 ${metrics.totalRequests || 0}，API 调用 ${metrics.providerCalls || 0}，平均延迟 ${metrics.averageLatencyMs || 0} ms`">{{ metricLabel }}</span>
        <span v-if="contactLabel" class="contact-badge" :title="selectedConversation?.id">{{ contactLabel }}</span>
        <span v-if="controlFeedback.message" class="save-feedback" :class="controlFeedback.state">{{ controlFeedback.message }}</span>
        <span class="precise-badge">精准翻译</span>
      </div>
    </header>

    <header v-else class="account-toolbar empty-toolbar">
      <strong>请选择或添加一个账号</strong>
      <div class="empty-toolbar-actions"><span class="quota-badge" :class="{ low: quotaLow }">余 {{ remainingCharsLabel }} 字符</span><button class="toolbar-settings" @click="openSettings">翻译设置</button></div>
    </header>

    <main class="content" :class="{ 'signal-content': selectedIsSignal }">
      <SignalView v-if="selectedIsSignal" :account-record="selected!" @linked="reload" />
      <div v-else-if="!selected" class="empty"><h2>添加或选择一个账号</h2><p>WhatsApp 使用原生 WhatsApp Web 界面，Signal 使用内置聊天界面。</p></div>
    </main>

    <SettingsPanel v-if="showSettings" @close="closeSettings" />
    <PersonalCenter v-if="showProfile" @close="closeProfile" @updated="onProfileUpdated" />
    <div v-if="error" class="toast">{{ error }}</div>
  </div>
</template>
