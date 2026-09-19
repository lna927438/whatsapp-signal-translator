<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import { uiError, uiLanguage } from '../lib/uiLocale'

const props = defineProps<{ windowId: string; windowLabel: string }>()
const emit = defineEmits<{ close: [] }>()
const panel = ref<HTMLElement>()
const result = ref<{ code: string; expiresInSeconds: number; extensionDirectory: string; extensionId: string; translationReady: boolean } | null>(null)
const busy = ref(false), error = ref('')
let disposed = false
async function prepare() {
  if (busy.value) return
  busy.value = true; error.value = ''
  try {
    const prepared = await window.desktopAPI.setupGoogleVoiceTranslation(props.windowId)
    if (!disposed) result.value = prepared
  } catch (e: any) { if (!disposed) error.value = uiError(e?.message) }
  finally { if (!disposed) busy.value = false }
}
function focusTrap(event: KeyboardEvent) {
  if (event.key !== 'Tab') return
  const elements = [...(panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)') || [])]
  const first = elements[0], last = elements.at(-1)
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}
onMounted(async () => { await nextTick(); panel.value?.querySelector<HTMLButtonElement>('button')?.focus(); void prepare() })
onUnmounted(() => { disposed = true; result.value = null })
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')" @keydown.esc.stop="emit('close')">
    <section ref="panel" class="panel voice-translation-setup" role="dialog" aria-modal="true" :aria-label="uiLanguage === 'en' ? 'Connect Google Voice translation' : '连接 Google Voice 翻译'" @keydown="focusTrap">
      <header><h2>{{ uiLanguage === 'en' ? 'Connect translation' : '连接翻译' }}</h2><button type="button" :aria-label="uiLanguage === 'en' ? 'Close' : '关闭'" @click="emit('close')">×</button></header>
      <p class="voice-setup-window">{{ windowLabel }}</p>
      <p class="voice-setup-warning" role="status">{{ uiLanguage === 'en' ? 'Translation beta for recognized text-only conversations. Preview and confirm before sending. Check the helper’s protection status on the page; pairing alone does not mean protection is active.' : '支持已识别会话的纯文字翻译，发送前先预览并确认。请查看网页助手的保护状态；配对成功本身不代表发送保护已生效。' }}</p>
      <p v-if="busy" role="status">{{ uiLanguage === 'en' ? 'Preparing the extension and pairing code…' : '正在准备扩展和配对码…' }}</p>
      <p v-if="error" class="voice-setup-error" role="alert">{{ error }}</p>
      <template v-if="result">
        <ol>
          <li>{{ uiLanguage === 'en' ? 'In this Google Voice browser, open the extensions page and enable developer mode.' : '在当前 Google Voice 所用的浏览器里打开扩展管理页，并开启开发者模式。' }}</li>
          <li>{{ uiLanguage === 'en' ? 'Choose “Load unpacked” and select the extension folder that just opened.' : '选择“加载已解压的扩展”，选中刚打开的扩展文件夹。' }}</li>
          <li>{{ uiLanguage === 'en' ? 'Open the extension and paste the pairing code within 5 minutes.' : '打开扩展，在 5 分钟内粘贴配对码。' }}</li>
          <li>{{ uiLanguage === 'en' ? 'Close the extensions management window, then choose Reconnect in HelloDog.' : '安装和配对后，关闭扩展管理窗口，再点击 HelloDog 中的“重新接入”。' }}</li>
          <li>{{ uiLanguage === 'en' ? 'Open an existing text conversation and check the helper’s status. After sending, verify the result in the conversation.' : '打开已有短信会话，检查网页助手状态。发送后，在会话中核对实际结果。' }}</li>
        </ol>
        <label>{{ uiLanguage === 'en' ? 'Pairing code' : '配对码' }}<input :value="result.code" readonly spellcheck="false" autocomplete="off" @focus="($event.target as HTMLInputElement).select()" /></label>
        <small>{{ uiLanguage === 'en' ? 'Send protection does not yet support attachments or new-recipient messages. If the extension is disconnected or the page is unrecognized, do not assume a direct website send is protected.' : '附件和新建收件人短信暂不支持发送保护。扩展未连接或页面未识别时，请勿将网页直接发送视为已受保护。' }}</small>
      </template>
      <footer><button type="button" class="secondary" :disabled="busy" @click="prepare">{{ uiLanguage === 'en' ? (result ? 'Get a new pairing code' : 'Retry') : (result ? '重新获取配对码' : '重试') }}</button><button type="button" class="primary" @click="emit('close')">{{ uiLanguage === 'en' ? 'Close' : '关闭' }}</button></footer>
    </section>
  </div>
</template>

<style scoped>
.voice-translation-setup { width: min(560px, calc(100vw - 40px)); max-height: calc(100vh - 48px); padding: 22px; overflow: auto; }
.voice-translation-setup header { display: flex; justify-content: space-between; align-items: center; padding: 0; }
.voice-translation-setup header h2 { margin: 0; font-size: 20px; }
.voice-translation-setup header button { border: 0; background: transparent; color: var(--text); font-size: 24px; }
.voice-setup-window, .voice-translation-setup small { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.voice-setup-warning { padding: 12px; border: 1px solid #8c693e; border-radius: 8px; color: #e7c593; background: #312820; font-size: 13px; line-height: 1.7; }
.voice-translation-setup ol { padding-left: 24px; font-size: 13px; line-height: 1.8; }
.voice-translation-setup li + li { margin-top: 8px; }
.voice-translation-setup label { display: block; font-size: 13px; }
.voice-translation-setup input { display: block; margin: 8px 0; width: 100%; padding: 9px; }
.voice-translation-setup footer { display: flex; gap: 10px; justify-content: flex-end; margin-top: 22px; padding: 0; }
.voice-setup-error { color: #f19b92; }
</style>
