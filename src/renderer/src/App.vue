<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import SettingsPanel from './components/SettingsPanel.vue'
import SignalView from './components/SignalView.vue'

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
}

type LiveStatus = { state: 'ready'|'working'|'success'|'error'; message: string; at?: number }

const accounts = ref<Account[]>([])
const selected = ref<Account | null>(null)
const showSettings = ref(false)
const error = ref('')
const settings = ref<any>(null)
const languages = ref<any[]>([])
const liveStatuses = ref<Record<string, LiveStatus>>({})
const controlFeedback = ref<{ state: 'idle'|'saving'|'saved'|'error'; message: string }>({ state: 'idle', message: '' })
let feedbackTimer: ReturnType<typeof setTimeout> | undefined

const selectedIsSignal = computed(() => selected.value?.platform === 'signal')
const localLanguage = computed(() => selected.value?.localLanguage || settings.value?.localLanguage || 'zh-CN')
const targetLanguage = computed(() => selected.value?.targetLanguage || settings.value?.targetLanguage || 'en-US')
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
  if (selected.value?.id && liveStatuses.value[selected.value.id]) return liveStatuses.value[selected.value.id]
  return { state: 'ready', message: selected.value?.platform === 'signal' ? 'Signal 翻译就绪' : '翻译器就绪' }
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

async function openSettings() {
  await window.desktopAPI.setOverlayOpen(true)
  showSettings.value = true
}

async function closeSettings() {
  showSettings.value = false
  await reloadSettings()
  await window.desktopAPI.setOverlayOpen(false)
}

onMounted(async () => {
  await Promise.all([reload(), reloadSettings()])
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
      <button class="settings-btn" @click="openSettings">⚙ 设置</button>
    </aside>

    <header v-if="selected" class="account-toolbar">
      <div class="account-control-row">
        <label class="check-label" title="开启后自动把对方消息翻译成我的语言">
          <input type="checkbox" :checked="receiveAutoTranslate" @change="patchSelected({ receiveAutoTranslate: !receiveAutoTranslate })" />
          <span>对方的语言</span>
        </label>
        <select :value="targetLanguage" @change="setStringField('targetLanguage', $event)">
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

        <div class="live-status" :class="selectedLiveStatus.state" :title="selectedLiveStatus.message">
          <i></i><span>{{ selectedLiveStatus.message }}</span>
        </div>
        <span v-if="controlFeedback.message" class="save-feedback" :class="controlFeedback.state">{{ controlFeedback.message }}</span>
        <span class="precise-badge">精准翻译</span>
      </div>
    </header>

    <header v-else class="account-toolbar empty-toolbar">
      <strong>请选择或添加一个账号</strong>
      <button class="toolbar-settings" @click="openSettings">翻译设置</button>
    </header>

    <main class="content" :class="{ 'signal-content': selectedIsSignal }">
      <SignalView v-if="selectedIsSignal" :account-record="selected!" @linked="reload" />
      <div v-else-if="!selected" class="empty">
        <h2>添加或选择一个账号</h2><p>WhatsApp 使用原生 WhatsApp Web 界面，Signal 使用内置聊天界面。</p>
      </div>
    </main>

    <SettingsPanel v-if="showSettings" @close="closeSettings" />
    <div v-if="error" class="toast">{{ error }}</div>
  </div>
</template>
