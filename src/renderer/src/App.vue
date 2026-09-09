<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import SettingsPanel from './components/SettingsPanel.vue'
import SignalView from './components/SignalView.vue'

type Account = { id: string; platform: 'whatsapp'|'signal'; label: string; signalAccount?: string }
const accounts = ref<Account[]>([])
const selected = ref<Account | null>(null)
const showSettings = ref(false)
const error = ref('')

const selectedIsSignal = computed(() => selected.value?.platform === 'signal')

async function reload() { accounts.value = await window.desktopAPI.listAccounts() }
async function addWhatsApp() {
  const a = await window.desktopAPI.addAccount({ platform: 'whatsapp' })
  await reload(); await select(a)
}
async function addSignalRecord(signalAccount?: string) {
  const a = await window.desktopAPI.addAccount({ platform: 'signal', signalAccount })
  await reload(); await select(a)
}
async function select(a: Account) {
  selected.value = a
  await window.desktopAPI.focusPlatform({ platform: a.platform, accountId: a.id })
}
async function remove(a: Account) {
  await window.desktopAPI.removeAccount(a.id)
  if (selected.value?.id === a.id) { selected.value = null; await window.desktopAPI.focusPlatform({ platform: 'signal' }) }
  await reload()
}

onMounted(async () => {
  await reload()
  window.desktopAPI.onTranslatorError((m: string) => { error.value = m; setTimeout(() => error.value = '', 5000) })
})
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark">译</div><div><b>Realtime Translator</b><small>WhatsApp + Signal</small></div></div>
      <button class="add wa" @click="addWhatsApp">＋ WhatsApp</button>
      <button class="add signal" @click="addSignalRecord()">＋ Signal</button>
      <div class="account-list">
        <button v-for="a in accounts" :key="a.id" class="account" :class="{ active: selected?.id===a.id }" @click="select(a)">
          <span class="dot" :class="a.platform"></span><span class="account-label">{{ a.label }}</span><span class="close" @click.stop="remove(a)">×</span>
        </button>
      </div>
      <button class="settings-btn" @click="showSettings=true">⚙ Settings</button>
    </aside>

    <header class="toolbar">
      <div><small>Translation mode</small><strong>Precise Translation</strong></div>
      <div class="toolbar-note">Incoming and outgoing text are translated faithfully without rewriting.</div>
      <button @click="showSettings=true">Translation Settings</button>
    </header>

    <main class="content" :class="{ 'signal-content': selectedIsSignal }">
      <SignalView v-if="selectedIsSignal" :account-record="selected!" @linked="reload" />
      <div v-else-if="!selected" class="empty">
        <h2>Add or select an account</h2><p>WhatsApp opens the original WhatsApp Web interface. Signal uses the built-in chat view.</p>
      </div>
    </main>

    <SettingsPanel v-if="showSettings" @close="showSettings=false" />
    <div v-if="error" class="toast">{{ error }}</div>
  </div>
</template>
