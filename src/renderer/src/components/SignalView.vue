<script setup lang="ts">
import QRCode from 'qrcode'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

const props = defineProps<{ accountRecord: any }>()
const emit = defineEmits(['linked'])
const signalAccounts = ref<string[]>([])
const activeAccount = ref(props.accountRecord.signalAccount || '')
const recipient = ref('')
const input = ref('')
const messages = ref<any[]>([])
const linkUri = ref('')
const qr = ref('')
const status = ref('')
const diagnostic = ref('')
const runtime = ref<any>({ state: 'checking', message: 'Checking Signal runtime…' })
let offMessage: undefined | (() => void)
let offRuntime: undefined | (() => void)
let offDiagnostic: undefined | (() => void)

const runtimeReady = computed(() => runtime.value?.state === 'ready')
const runtimeBusy = computed(() => ['checking', 'downloading-signal', 'downloading-java', 'installing'].includes(runtime.value?.state))

async function refreshRuntime() {
  try {
    runtime.value = await window.desktopAPI.signalRuntimeStatus()
  } catch (error: any) {
    runtime.value = { state: 'error', message: error.message || String(error) }
  }
}

async function prepareRuntime() {
  status.value = 'Preparing Signal core. The first setup downloads signal-cli and Java 25…'
  diagnostic.value = ''
  try {
    runtime.value = await window.desktopAPI.signalPrepareRuntime()
    status.value = 'Signal core is ready.'
    await refreshAccounts()
  } catch (error: any) {
    status.value = error.message || String(error)
  }
}

async function refreshAccounts() {
  if (!runtimeReady.value) return
  try {
    signalAccounts.value = await window.desktopAPI.signalListAccounts()
    if (!activeAccount.value && signalAccounts.value[0]) activeAccount.value = signalAccounts.value[0]
  } catch (error: any) {
    status.value = error.message || String(error)
  }
}

async function startLink() {
  if (!runtimeReady.value) await prepareRuntime()
  if (!runtimeReady.value) return
  try {
    status.value = 'Starting Signal link…'
    const result = await window.desktopAPI.signalStartLink()
    linkUri.value = result.deviceLinkUri
    qr.value = await QRCode.toDataURL(linkUri.value, { width: 220, margin: 1 })
    status.value = 'Scan this QR code from Signal → Settings → Linked devices.'
  } catch (error: any) {
    status.value = error.message || String(error)
  }
}

async function finishLink() {
  if (!linkUri.value) return
  try {
    status.value = 'Waiting for Signal to finish linking…'
    await window.desktopAPI.signalFinishLink(linkUri.value, 'Realtime Translator')
    linkUri.value = ''
    qr.value = ''
    await refreshAccounts()
    if (activeAccount.value) await window.desktopAPI.updateAccount(props.accountRecord.id, { signalAccount: activeAccount.value })
    emit('linked')
    status.value = 'Signal linked.'
  } catch (error: any) {
    status.value = error.message || String(error)
  }
}

async function send() {
  const text = input.value.trim()
  if (!text || !activeAccount.value || !recipient.value.trim()) return
  input.value = ''
  try {
    const message = await window.desktopAPI.signalSend(activeAccount.value, recipient.value.trim(), text)
    messages.value.push(message)
  } catch (error: any) {
    input.value = text
    status.value = error.message || String(error)
  }
}

watch(activeAccount, async (value) => {
  if (value) await window.desktopAPI.updateAccount(props.accountRecord.id, { signalAccount: value })
})

onMounted(async () => {
  await window.desktopAPI.focusPlatform({ platform: 'signal' })
  offRuntime = window.desktopAPI.onSignalRuntime((next: any) => { runtime.value = next })
  offDiagnostic = window.desktopAPI.onSignalDiagnostic((message: string) => { diagnostic.value = message.trim() })
  offMessage = window.desktopAPI.onSignalMessage((message: any) => {
    if (!activeAccount.value || message.account === activeAccount.value) messages.value.push(message)
  })
  await refreshRuntime()
  if (runtimeReady.value) await refreshAccounts()
})

onUnmounted(() => {
  offMessage?.()
  offRuntime?.()
  offDiagnostic?.()
})
</script>

<template>
  <div class="signal-view">
    <div class="signal-top">
      <div>
        <h2>Signal</h2>
        <p v-if="activeAccount">Linked as {{ activeAccount }}</p>
        <p v-else>No linked Signal account found.</p>
      </div>
      <select v-if="signalAccounts.length" v-model="activeAccount">
        <option v-for="account in signalAccounts" :key="account" :value="account">{{ account }}</option>
      </select>
      <button :disabled="runtimeBusy" @click="startLink">Link Signal</button>
    </div>

    <div v-if="!runtimeReady" class="runtime-card">
      <div class="runtime-row">
        <div>
          <strong>Signal Core</strong>
          <p>{{ runtime.message || 'Signal runtime is required.' }}</p>
        </div>
        <span class="runtime-state" :class="runtime.state">{{ runtime.state }}</span>
      </div>
      <div v-if="typeof runtime.progress === 'number'" class="runtime-progress">
        <div :style="{ width: runtime.progress + '%' }"></div>
      </div>
      <button class="primary" :disabled="runtimeBusy" @click="prepareRuntime">
        {{ runtimeBusy ? 'Preparing…' : 'Prepare Signal automatically' }}
      </button>
      <small>First setup downloads the current signal-cli release and a Java 25 runtime from their upstream providers.</small>
    </div>

    <div v-if="qr" class="qr-box">
      <img :src="qr" />
      <p>{{ status }}</p>
      <button class="primary" @click="finishLink">I scanned it — finish linking</button>
    </div>
    <p v-else-if="status" class="status">{{ status }}</p>
    <p v-if="diagnostic && runtimeReady" class="diagnostic">{{ diagnostic }}</p>

    <template v-if="runtimeReady">
      <div class="signal-recipient">
        <label>Recipient phone number<input v-model="recipient" placeholder="+1…" /></label>
      </div>
      <div class="messages">
        <div v-for="message in messages" :key="message.timestamp + ':' + message.peer" class="msg" :class="{ mine: message.fromMe }">
          <div class="bubble">
            <div>{{ message.original }}</div>
            <div v-if="message.translated && message.translated !== message.original" class="translated">{{ message.translated }}</div>
          </div>
        </div>
      </div>
      <div class="composer">
        <textarea v-model="input" @keydown.enter.exact.prevent="send" placeholder="Type in your language…"></textarea>
        <button class="primary" @click="send">Translate & Send</button>
      </div>
    </template>
  </div>
</template>
