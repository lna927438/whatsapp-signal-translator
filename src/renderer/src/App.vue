<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import SettingsPanel from './components/SettingsPanel.vue'
import SignalView from './components/SignalView.vue'

type Account = { id: string; platform: 'whatsapp'|'signal'; label: string; signalAccount?: string }
const accounts = ref<Account[]>([])
const selected = ref<Account | null>(null)
const showSettings = ref(false)
const error = ref('')
const settings = ref<any>(null)
const languages = ref<any[]>([])

const selectedIsSignal = computed(() => selected.value?.platform === 'signal')
const languageName = (code?: string) => {
  const item = languages.value.find((language) => language.code === code)
  return item?.zhName || item?.name || code || '—'
}
const providerName = computed(() => {
  const value = settings.value?.provider
  if (value === 'openai') return 'OpenAI'
  if (value === 'deepl') return 'DeepL'
  if (value === 'google') return 'Google 翻译'
  return '—'
})

async function reload() { accounts.value = await window.desktopAPI.listAccounts() }
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
  window.desktopAPI.onTranslatorError((message: string) => {
    error.value = message
    setTimeout(() => error.value = '', 6000)
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

    <header class="toolbar">
      <div class="toolbar-field"><small>我的语言</small><strong>{{ languageName(settings?.localLanguage) }}</strong></div>
      <div class="toolbar-field"><small>对方语言</small><strong>{{ languageName(settings?.targetLanguage) }}</strong></div>
      <div class="toolbar-field"><small>翻译引擎</small><strong>{{ providerName }}</strong></div>
      <div class="toolbar-field"><small>模式</small><strong>精准翻译</strong></div>
      <div class="toolbar-spacer"></div>
      <div class="auto-state">
        <span :class="{ on: settings?.receiveAutoTranslate }">接收翻译</span>
        <span :class="{ on: settings?.sendAutoTranslate }">发送翻译</span>
        <span :class="{ on: settings?.blockChineseSend }">禁止中文</span>
      </div>
      <button @click="openSettings">翻译设置</button>
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
