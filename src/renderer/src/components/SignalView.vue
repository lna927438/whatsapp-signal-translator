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
const linking = ref(false)
const runtime = ref<any>({ state: 'checking', message: 'Checking Signal runtime…' })
let linkAttempt = 0
let offMessage: undefined | (() => void)
let offRuntime: undefined | (() => void)
let offDiagnostic: undefined | (() => void)

const runtimeReady = computed(() => runtime.value?.state === 'ready')
const runtimeBusy = computed(() => ['checking', 'downloading-signal', 'downloading-java', 'installing'].includes(runtime.value?.state))
const prepareLabel = computed(() => {
  if (runtimeBusy.value) return 'Preparing…'
  if (runtime.value?.state === 'error') return 'Repair Signal Core'
  return 'Prepare Signal automatically'
})

async function refreshRuntime() {
  try {
    runtime.value = await window.desktopAPI.signalRuntimeStatus()
  } catch (error: any) {
    runtime.value = { state: 'error', message: error.message || String(error) }
  }
}

async function prepareRuntime() {
  status.value = runtime.value?.state === 'error'
    ? 'Repairing Signal core…'
    : 'Preparing Signal core. The first setup downloads signal-cli and Java 25…'
  diagnostic.value = ''
  try {
    runtime.value = await window.desktopAPI.signalPrepareRuntime()
    status.value = 'Signal core is ready and verified.'
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
  if (linking.value) return
  if (!runtimeReady.value) await prepareRuntime()
  if (!runtimeReady.value) return

  const attempt = ++linkAttempt
  linking.value = true
  diagnostic.value = ''
  qr.value = ''
  linkUri.value = ''
  status.value = 'Creating a fresh Signal device link…'

  try {
    const result = await window.desktopAPI.signalStartLink()
    if (attempt !== linkAttempt) return

    const uri = String(result?.deviceLinkUri || '')
    if (!uri.startsWith('sgnl://linkdevice?')) throw new Error('Signal returned an invalid device-link URI.')

    linkUri.value = uri

    // finishLink must already be waiting when the primary phone scans the QR.
    // Calling it only after the scan can make Signal report an invalid server response.
    const finishPromise = window.desktopAPI.signalFinishLink(uri, 'Realtime Translator')
    qr.value = await QRCode.toDataURL(uri, { width: 260, margin: 2, errorCorrectionLevel: 'M' })
    status.value = 'Scan now in Signal → Settings → Linked devices. The desktop is already waiting for approval.'

    void completeLink(finishPromise, attempt)
  } catch (error: any) {
    if (attempt !== linkAttempt) return
    linking.value = false
    linkUri.value = ''
    qr.value = ''
    status.value = error.message || String(error)
  }
}

async function completeLink(finishPromise: Promise<any>, attempt: number) {
  try {
    const result = await finishPromise
    if (attempt !== linkAttempt) return

    const linkedNumber = String(result?.number || '')
    await refreshAccounts()
    if (linkedNumber) activeAccount.value = linkedNumber
    else if (!activeAccount.value && signalAccounts.value[0]) activeAccount.value = signalAccounts.value[0]

    if (activeAccount.value) {
      await window.desktopAPI.updateAccount(props.accountRecord.id, { signalAccount: activeAccount.value })
    }

    qr.value = ''
    linkUri.value = ''
    status.value = activeAccount.value ? `Signal linked successfully as ${activeAccount.value}.` : 'Signal linked successfully.'
    emit('linked')
  } catch (error: any) {
    if (attempt !== linkAttempt) return
    qr.value = ''
    linkUri.value = ''
    const message = String(error?.message || error)
    status.value = /timed out/i.test(message)
      ? 'Signal linking timed out. Click Link Signal to generate a fresh QR code and scan it promptly.'
      : `Signal linking failed: ${message}`
  } finally {
    if (attempt === linkAttempt) linking.value = false
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
  linkAttempt += 1
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
      <button :disabled="runtimeBusy || linking" @click="startLink">{{ linking ? 'Waiting for scan…' : 'Link Signal' }}</button>
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
      <button class="primary" :disabled="runtimeBusy" @click="prepareRuntime">{{ prepareLabel }}</button>
      <small>Setup uses the current signal-cli release and Java 25. If startup fails, Repair Signal Core replaces only the runtime files; linked-account data is kept separately.</small>
    </div>

    <div v-if="qr" class="qr-box signal-link-box">
      <img :src="qr" />
      <div class="link-wait"><span class="link-dot"></span><strong>Waiting for your phone</strong></div>
      <p>{{ status }}</p>
      <small>Do not press another desktop button after scanning. Approval completes automatically.</small>
    </div>
    <p v-else-if="status" class="status">{{ status }}</p>
    <p v-if="diagnostic" class="diagnostic">{{ diagnostic }}</p>

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
