<script setup lang="ts">
import QRCode from 'qrcode'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { readDraft, saveDraft, clearSentDraft, upsertMessage, type DraftScope } from '../lib/signalState'

const props = defineProps<{ accountRecord: any; userId: string }>()
const emit = defineEmits(['linked', 'conversation'])
const signalAccounts = ref<string[]>([])
const activeAccount = ref(props.accountRecord.signalAccount || '')
const peerKey = 'translator-signal-peer:' + JSON.stringify([props.userId, props.accountRecord.id])
const recipient = ref(localStorage.getItem(peerKey) || '')
const scope = (): DraftScope => ({ userId: props.userId, recordId: props.accountRecord.id, account: activeAccount.value, peer: recipient.value.trim() })
const input = ref(readDraft(localStorage, scope()))
const messages = ref<any[]>([])
const linkUri = ref('')
const qr = ref('')
const status = ref('')
const diagnostic = ref('')
const linking = ref(false)
const sending = ref(false)
const pendingTask = ref<any>(null)
const uncertain = computed(() => ['uncertain', 'submitting'].includes(pendingTask.value?.state))
const visibleMessages = computed(() => messages.value.filter(message => message.account === activeAccount.value && message.peer === recipient.value.trim()))
let disposed = false
let recoverySequence = 0
let accountSave: Promise<any> = Promise.resolve()
const runtime = ref<any>({ state: 'checking', message: '正在检查 Signal 核心…' })
let linkAttempt = 0
let offMessage: undefined | (() => void)
let offRuntime: undefined | (() => void)
let offDiagnostic: undefined | (() => void)

const runtimeReady = computed(() => runtime.value?.state === 'ready')
const runtimeBusy = computed(() => ['checking', 'downloading-signal', 'downloading-java', 'installing'].includes(runtime.value?.state))
const translatedStyle = computed(() => ({
  display: props.accountRecord.translationsVisible === false ? 'none' : undefined,
  fontSize: `${Number(props.accountRecord.fontSize || 13)}px`,
  color: props.accountRecord.translationColor || '#c8d4e4'
}))
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
  try { runtime.value = await window.desktopAPI.signalRuntimeStatus() }
  catch (error: any) { runtime.value = { state: 'error', message: error.message || String(error) } }
}

async function prepareRuntime() {
  status.value = runtime.value?.state === 'error' ? '正在修复 Signal 核心…' : '正在准备 Signal 核心。首次使用会自动下载 signal-cli 和 Java 25…'
  diagnostic.value = ''
  try {
    runtime.value = await window.desktopAPI.signalPrepareRuntime()
    status.value = 'Signal 核心已准备并验证完成。'
    await refreshAccounts()
  } catch (error: any) { status.value = error.message || String(error) }
}

async function refreshAccounts() {
  if (!runtimeReady.value) return
  try {
    signalAccounts.value = await window.desktopAPI.signalListAccounts()
    if (!activeAccount.value && signalAccounts.value[0]) activeAccount.value = signalAccounts.value[0]
  } catch (error: any) { status.value = error.message || String(error) }
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
    if (activeAccount.value) await window.desktopAPI.updateAccount(props.accountRecord.id, { signalAccount: activeAccount.value })
    qr.value = ''
    linkUri.value = ''
    status.value = activeAccount.value ? `Signal 绑定成功：${activeAccount.value}` : 'Signal 绑定成功。'
    emit('linked')
  } catch (error: any) {
    if (attempt !== linkAttempt) return
    qr.value = ''
    linkUri.value = ''
    const message = String(error?.message || error)
    status.value = /timed out/i.test(message) ? 'Signal 绑定超时。请重新点击“关联 Signal”生成新的二维码，并尽快扫码。' : `Signal 绑定失败：${message}`
  } finally { if (attempt === linkAttempt) linking.value = false }
}

async function recoverPending() {
  const sequence = ++recoverySequence
  const current = scope()
  pendingTask.value = null
  if (!current.account || !current.peer) return
  try {
    const task = await window.desktopAPI.pendingSend(current.recordId, `signal:${current.peer}`)
    if (disposed || sequence !== recoverySequence || task?.signalAccount !== current.account) return
    pendingTask.value = task
    if (task && !input.value && !['uncertain', 'submitting'].includes(task.state)) input.value = task.request.text
  } catch (error: any) { if (!disposed && sequence === recoverySequence) status.value = error.message || String(error) }
}

async function resolvePending(sent: boolean) {
  const task = pendingTask.value
  if (!task || sending.value) return
  const current = scope()
  try {
    if (sent) {
      await window.desktopAPI.confirmSent(task.id)
      if (clearSentDraft(localStorage, current, task.request.text) && current.account === activeAccount.value && current.peer === recipient.value.trim() && input.value.trim() === task.request.text.trim()) input.value = ''
      status.value = '已记录核对结果，不会重复发送。'
    } else {
      await window.desktopAPI.confirmNotSent(task.id)
      status.value = '原任务可重试，已保存的译文会继续使用。请核对收件人后点击发送。'
    }
    await recoverPending()
  } catch (error: any) { status.value = error.message || String(error) }
}

async function cancelPending() {
  if (!pendingTask.value || sending.value) return
  try {
    await window.desktopAPI.cancelSend(pendingTask.value.id)
    status.value = '任务已取消。下次发送将使用当前翻译设置。'
    await recoverPending()
  } catch (error: any) { status.value = error.message || String(error) }
}

async function send() {
  const text = input.value.trim()
  const current = scope()
  if (sending.value || uncertain.value || !text || !current.account || !current.peer) return
  sending.value = true
  try {
    // Keep the editor and its newer draft intact throughout every await.
    saveDraft(localStorage, current, input.value)
    await accountSave
    if (disposed || current.account !== activeAccount.value || current.peer !== recipient.value.trim()) throw new Error('对话已切换，草稿已保留。')
    status.value = '正在保存任务并确认译文…'
    let task = await window.desktopAPI.prepareSignalSend(current.recordId, current.account, current.peer, text)
    pendingTask.value = task
    if (['uncertain', 'submitting'].includes(task.state)) { status.value = '请先核对上一次发送的结果。'; return }
    task = await window.desktopAPI.translateSend(task.id)
    if (disposed || current.account !== activeAccount.value || current.peer !== recipient.value.trim() || input.value.trim() !== text) throw new Error('对话或草稿已变化，译文已保存，没有发送。')
    status.value = '译文已确认，正在等待 Signal 发送确认…'
    const sent = await window.desktopAPI.submitSend(task.id)
    if (disposed) return
    if (sent.result?.account) messages.value = upsertMessage(messages.value, sent.result)
    const cleared = clearSentDraft(localStorage, current, text)
    if (cleared && current.account === activeAccount.value && current.peer === recipient.value.trim() && input.value.trim() === text) input.value = ''
    status.value = 'Signal 已确认提交发送。'
  } catch (error: any) {
    if (!disposed) status.value = (error.message || String(error)) + ' 原任务和草稿已保留。'
  } finally {
    sending.value = false
    if (!disposed) await recoverPending()
  }
}

watch(input, value => {
  try { saveDraft(localStorage, scope(), value) }
  catch { status.value = '本地草稿保存失败，请先复制输入内容。'; }
}, { flush: 'sync' })
watch([activeAccount, recipient], () => {
  input.value = readDraft(localStorage, scope())
  localStorage.setItem(peerKey, recipient.value)
  void recoverPending()
}, { flush: 'sync' })
watch(activeAccount, value => {
  if (value) {
    accountSave = accountSave.catch(() => {}).then(() => window.desktopAPI.updateAccount(props.accountRecord.id, { signalAccount: value }))
    void accountSave.catch(error => { if (!disposed) status.value = error.message || String(error) })
  }
})
watch(recipient, value => {
  const peer = value.trim()
  if (peer) emit('conversation', { id: `signal:${peer}`, name: peer })
}, { immediate: true })

onMounted(async () => {
  await window.desktopAPI.focusPlatform({ platform: 'signal' })
  if (disposed) return
  offRuntime = window.desktopAPI.onSignalRuntime((next: any) => { runtime.value = next })
  offDiagnostic = window.desktopAPI.onSignalDiagnostic((message: string) => { diagnostic.value = message.trim() })
  offMessage = window.desktopAPI.onSignalMessage((message: any) => {
    if (!disposed && message.account === activeAccount.value) messages.value = upsertMessage(messages.value, message)
  })
  await refreshRuntime()
  if (runtimeReady.value) await refreshAccounts()
  await recoverPending()
})

onUnmounted(() => {
  disposed = true
  recoverySequence += 1
  linkAttempt += 1
  offMessage?.()
  offRuntime?.()
  offDiagnostic?.()
})
</script>

<template>
  <div class="signal-view">
    <div class="signal-top">
      <div><h2>Signal</h2><p v-if="activeAccount">已绑定账号：{{ activeAccount }}</p><p v-else>尚未绑定 Signal 账号。</p></div>
      <select v-if="signalAccounts.length" v-model="activeAccount"><option v-for="account in signalAccounts" :key="account" :value="account">{{ account }}</option></select>
      <button :disabled="runtimeBusy || linking" @click="startLink">{{ linking ? '等待扫码…' : '关联 Signal' }}</button>
    </div>

    <div v-if="!runtimeReady" class="runtime-card">
      <div class="runtime-row"><div><strong>Signal 核心</strong><p>{{ runtime.message || '需要先准备 Signal 运行环境。' }}</p></div><span class="runtime-state" :class="runtime.state">{{ runtimeStateLabel }}</span></div>
      <div v-if="typeof runtime.progress === 'number'" class="runtime-progress"><div :style="{ width: runtime.progress + '%' }"></div></div>
      <button class="primary" :disabled="runtimeBusy" @click="prepareRuntime">{{ prepareLabel }}</button>
      <small>首次准备会下载当前 signal-cli 和 Java 25。若启动失败，“修复 Signal 核心”只替换运行文件，不删除已绑定账号数据。</small>
    </div>

    <div v-if="qr" class="qr-box signal-link-box"><img :src="qr" /><div class="link-wait"><span class="link-dot"></span><strong>等待手机扫码确认</strong></div><p>{{ status }}</p><small>扫码后无需再点击电脑端按钮，绑定会自动完成。</small></div>
    <p v-else-if="status" class="status">{{ status }}</p>
    <p v-if="diagnostic" class="diagnostic">{{ diagnostic }}</p>

    <template v-if="runtimeReady">
      <div class="signal-recipient"><label>对方手机号<input v-model="recipient" placeholder="例如 +1…" /></label></div>
      <div class="messages">
        <div v-for="message in visibleMessages" :key="message.taskId || message.timestamp + ':' + message.peer + ':' + message.fromMe" class="msg" :class="{ mine: message.fromMe }"><div class="bubble"><div>{{ message.original }}</div><div v-if="message.translated && message.translated !== message.original" class="translated" :style="translatedStyle">{{ message.translated }}</div></div></div>
      </div>
      <div v-if="uncertain" class="runtime-card" role="status">
        <p>上次发送结果未确认。请先在手机 Signal 的原对话中核对，避免重复发送。</p>
        <button :disabled="sending" @click="resolvePending(true)">已确认发送成功</button>
        <button :disabled="sending" @click="resolvePending(false)">已核对未发送，允许重试</button>
      </div>
      <p v-else-if="pendingTask" class="status">原任务已保留；重试沿用原目标语言和已确认的译文。 <button :disabled="sending" @click="cancelPending">取消此待发送任务</button></p>
      <div class="composer"><textarea v-model="input" @keydown.enter.exact.prevent="send" placeholder="输入中文，发送前自动翻译…"></textarea><button class="primary" :disabled="sending || uncertain || !input.trim() || !recipient.trim()" @click="send">{{ sending ? '处理中…' : '翻译并发送' }}</button></div>
    </template>
  </div>
</template>
