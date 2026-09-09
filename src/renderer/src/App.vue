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
const languageName = (code?: string) => languages.value.find((item) => item.code === code)?.name || code || '—'
const providerName = computed(() => {
  const value = settings.value?.provider
  if (value === 'openai') return 'OpenAI'
  if (value === 'deepl') return 'DeepL'
  if (value === 'google') return 'Google Translate'
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
    setTimeout(() => error.value = '', 5000)
  })
})
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark">译</div><div><b>Realtime Translator</b><small>WhatsApp + Signal</small></div></div>
      <button class="add wa" @click="addWhatsApp">＋ WhatsApp</button>
      <button class="add signal" @click="addSignalRecord()">＋ Signal</button>
      <div class="account-list">
        <button v-for="account in accounts" :key="account.id" class="account" :class="{ active: selected?.id===account.id }" @click="select(account)">
          <span class="dot" :class="account.platform"></span><span class="account-label">{{ account.label }}</span><span class="close" @click.stop="remove(account)">×</span>
        </button>
      </div>
      <button class="settings-btn" @click="openSettings">⚙ Settings</button>
    </aside>

    <header class="toolbar">
      <div class="toolbar-field"><small>Your language</small><strong>{{ languageName(settings?.localLanguage) }}</strong></div>
      <div class="toolbar-field"><small>Recipient language</small><strong>{{ languageName(settings?.targetLanguage) }}</strong></div>
      <div class="toolbar-field"><small>Provider</small><strong>{{ providerName }}</strong></div>
      <div class="toolbar-field"><small>Mode</small><strong>Precise Translation</strong></div>
      <div class="toolbar-spacer"></div>
      <div class="auto-state">
        <span :class="{ on: settings?.receiveAutoTranslate }">Receive</span>
        <span :class="{ on: settings?.sendAutoTranslate }">Send</span>
      </div>
      <button @click="openSettings">Translation Settings</button>
    </header>

    <main class="content" :class="{ 'signal-content': selectedIsSignal }">
      <SignalView v-if="selectedIsSignal" :account-record="selected!" @linked="reload" />
      <div v-else-if="!selected" class="empty">
        <h2>Add or select an account</h2><p>WhatsApp opens the original WhatsApp Web interface. Signal uses the built-in chat view.</p>
      </div>
    </main>

    <SettingsPanel v-if="showSettings" @close="closeSettings" />
    <div v-if="error" class="toast">{{ error }}</div>
  </div>
</template>
