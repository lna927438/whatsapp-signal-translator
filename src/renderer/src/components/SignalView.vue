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
const runtime = ref<any>({ state: 'checking', message: '正在检查 Signal 核心…' })
let linkAttempt = 0
let offMessage: undefined | (() => void)
let offRuntime: undefined | (() => void)
let offDiagnostic: undefined | (() => void)

const runtimeReady = computed(() => runtime.value?.state === 'ready')
const runtimeBusy = computed(() => ['checking', 'downloading-signal', 'downloading-java', 'installing'].includes(runtime.value?.state))
const prepareLabel = computed(() => {
  if (runtimeBusy.value) return '准备中…'
  if (runtime.value?.state === 'error') return '修复 Signal 核心'
  return '自动准备 Signal 核心'
})
const runtimeStateLabel = computed(() => {
  const state = runtime.value?.state
  if (state === 'ready') return '已就绪'
  if (state === 'checking') return '检查中'
  if (state === 'downloading-signal') return '下载 Signal'
  if (state === 'downloading-java') return '下载 Java'
  if (state === 'installing') return '安装中'
  if (state === 'error') return '错误'
  return '未安装'
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
    ? '正在修复 Signal 核心…'
    : '正在准备 Signal 核心。首次使用会自动下载 signal-cli 和 Java 25…'
  diagnostic.value = ''
  try {
    runtime.value = await window.desktopAPI.signalPrepareRuntime()
    status.value = 'Signal 核心已准备并验证完成。'
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
  status.value = '正在生成新的 Signal 设备关联链接…'

  try {
    const result = await window.desktopAPI.signalStartLink()
    if (attempt !== linkAttempt) return

    const uri = String(result?.deviceLinkUri || '')
    if (!uri.startsWith('sgnl://linkdevice?')) throw new Error('Signal 返回了无效的设备关联链接。')

    linkUri.value = uri

    const finishPromise = window.desktopAPI.signalFinishLink(uri, '实时翻译器')
    qr.value = await QRCode.toDataURL(uri, { width: 260, margin: 2, errorCorrectionLevel: 'M' })
    status.value = '请立即在手机 Signal 中打开“设置 → 已关联设备”扫描二维码。电脑端已在等待确认。'

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
    status.value = activeAccount.value ? `Signal 绑定成功：${activeAccount.value}` : 'Signal 绑定成功。'
    emit('linked')
  } catch (error: any) {
    if (attempt !== linkAttempt) return
    qr.value = ''
    linkUri.value = ''
    const message = String(error?.message || error)
    status.value = /timed out/i.test(message)
      ? 'Signal 绑定超时。请重新点击“关联 Signal”生成新的二维码，并尽快扫码。'
      : `Signal 绑定失败：${message}`
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
        <p v-if="activeAccount">已绑定账号：{{ activeAccount }}</p>
        <p v-else>尚未绑定 Signal 账号。</p>
      </div>
      <select v-if="signalAccounts.length" v-model="activeAccount">
        <option v-for="account in signalAccounts" :key="account" :value="account">{{ account }}</option>
      </select>
      <button :disabled="runtimeBusy || linking" @click="startLink">{{ linking ? '等待扫码…' : '关联 Signal' }}</button>
    </div>

    <div v-if="!runtimeReady" class="runtime-card">
      <div class="runtime-row">
        <div>
          <strong>Signal 核心</strong>
          <p>{{ runtime.message || '需要先准备 Signal 运行环境。' }}</p>
        </div>
        <span class="runtime-state" :class="runtime.state">{{ runtimeStateLabel }}</span>
      </div>
      <div v-if="typeof runtime.progress === 'number'" class="runtime-progress">
        <div :style="{ width: runtime.progress + '%' }"></div>
      </div>
      <button class="primary" :disabled="runtimeBusy" @click="prepareRuntime">{{ prepareLabel }}</button>
      <small>首次准备会下载当前 signal-cli 和 Java 25。若启动失败，“修复 Signal 核心”只替换运行文件，不删除已绑定账号数据。</small>
    </div>

    <div v-if="qr" class="qr-box signal-link-box">
      <img :src="qr" />
      <div class="link-wait"><span class="link-dot"></span><strong>等待手机扫码确认</strong></div>
      <p>{{ status }}</p>
      <small>扫码后无需再点击电脑端按钮，绑定会自动完成。</small>
    </div>
    <p v-else-if="status" class="status">{{ status }}</p>
    <p v-if="diagnostic" class="diagnostic">{{ diagnostic }}</p>

    <template v-if="runtimeReady">
      <div class="signal-recipient">
        <label>对方手机号<input v-model="recipient" placeholder="例如 +1…" /></label>
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
        <textarea v-model="input" @keydown.enter.exact.prevent="send" placeholder="输入中文，发送前自动翻译…"></textarea>
        <button class="primary" @click="send">翻译并发送</button>
      </div>
    </template>
  </div>
</template>
