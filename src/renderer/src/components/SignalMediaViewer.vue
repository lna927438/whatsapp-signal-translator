<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { mediaKind, type SignalMediaEntry, type SignalMediaAction, type SignalMediaActionResult } from '../../../shared/signalMedia'
import { t, uiError, uiLanguage } from '../lib/uiLocale'

const props = defineProps<{ accountId: string; items: SignalMediaEntry[]; selectedKey: string; staged?: boolean }>()
const emit = defineEmits(['close'])
const selected = ref(props.selectedKey), url = ref(''), error = ref(''), notice = ref(''), loading = ref(false), acting = ref(false)
const panel = ref<HTMLElement>(), closeButton = ref<HTMLButtonElement>()
const current = computed(() => props.items.find(item => item.key === selected.value))
const index = computed(() => props.items.findIndex(item => item.key === selected.value))
const kind = computed(() => mediaKind(current.value?.contentType || ''))
const timestamp = computed(() => current.value?.timestamp ? new Date(current.value.timestamp).toLocaleString(uiLanguage.value) : '')
let revision = 0, disposed = false
async function load() {
  const item = current.value, generation = ++revision
  url.value = ''; error.value = ''; notice.value = ''; acting.value = false
  if (!item) { emit('close'); return }
  loading.value = true
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([window.desktopAPI.signalMediaUrl(props.accountId, item.peer, item.id, props.staged),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(t('附件读取超时，可重试。'))), 10000) })])
    if (!disposed && revision === generation) url.value = result
  } catch (e: any) { if (!disposed && revision === generation) error.value = e.message || t('附件暂时无法打开') }
  finally { clearTimeout(timeout); if (!disposed && revision === generation) loading.value = false }
}
async function act(action: SignalMediaAction) {
  const item = current.value, generation = revision
  if (!item || acting.value || props.staged) return
  acting.value = true; notice.value = ''; error.value = ''
  try {
    const result: SignalMediaActionResult = await window.desktopAPI.signalMediaAction(props.accountId, item.peer, item.id, action)
    if (!disposed && revision === generation && result.success) notice.value = result.action === 'copy' ? t('图片已复制') : t('附件已保存')
  } catch (e: any) { if (!disposed && revision === generation) error.value = e.message || t('附件操作失败，请重试。') }
  finally { if (!disposed && revision === generation) acting.value = false }
}
function move(offset: number) { const item = props.items[index.value + offset]; if (item) selected.value = item.key }
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); emit('close') }
  if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1) }
  if (event.key === 'ArrowRight') { event.preventDefault(); move(1) }
  if (event.key === 'Tab') {
    const buttons = Array.from(panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled),video[controls],audio[controls]') || [])
    const first = buttons[0], last = buttons[buttons.length - 1]
    if (!first) return
    if (!panel.value?.contains(document.activeElement)) { event.preventDefault(); first.focus() }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }
}
watch(() => props.selectedKey, value => { selected.value = value })
watch(() => [props.accountId, current.value?.key, props.staged], load, { immediate: true })
onMounted(() => { document.addEventListener('keydown', keydown, true); void nextTick(() => closeButton.value?.focus()) })
onUnmounted(() => { disposed = true; revision++; document.removeEventListener('keydown', keydown, true) })
</script>
<template>
  <Teleport to="body">
    <div ref="panel" class="signal-media-lightbox" role="dialog" aria-modal="true" :aria-label="t('查看图片')" @click.self="emit('close')">
      <header class="smv-toolbar">
        <button ref="closeButton" class="smv-close" :aria-label="t('关闭图片')" @click="emit('close')">×</button>
        <div class="smv-title"><strong>{{ current?.filename }}</strong><small>{{ timestamp }} <span v-if="items.length > 1"> · {{ index + 1 }} / {{ items.length }}</span></small></div>
        <button v-if="!staged && kind === 'image'" :disabled="acting || loading || !url" @click="act('copy')">{{ t('复制图片') }}</button>
        <button v-if="!staged" :disabled="acting" @click="act('save')">{{ acting ? t('正在处理…') : t('保存附件') }}</button>
      </header>
      <button v-if="items.length > 1" class="smv-prev" :disabled="index <= 0" :aria-label="t('上一张')" @click="move(-1)">‹</button>
      <div class="smv-content" @contextmenu.prevent="act('menu')">
        <p v-if="loading" role="status">{{ t('正在读取附件…') }}</p>
        <img v-else-if="url && kind === 'image'" :src="url" :alt="current?.filename" @error="error = t('图片加载失败，可重试或保存')" />
        <video v-else-if="url && kind === 'video'" :src="url" controls playsinline />
        <audio v-else-if="url && kind === 'audio'" :src="url" controls />
      </div>
      <button v-if="items.length > 1" class="smv-next" :disabled="index >= items.length - 1" :aria-label="t('下一张')" @click="move(1)">›</button>
      <footer class="smv-status" aria-live="polite"><span v-if="error">{{ uiError(error) }} <button @click="load">{{ t('重试') }}</button></span><span v-else>{{ notice }}</span></footer>
    </div>
  </Teleport>
</template>
<style scoped>
.signal-media-lightbox{position:fixed;inset:0;z-index:9999;display:grid;grid-template-columns:64px minmax(0,1fr) 64px;grid-template-rows:72px minmax(0,1fr) 48px;background:#101216f5;color:#f7f8fa;font-family:inherit}.smv-toolbar{grid-column:1/-1;display:flex;align-items:center;gap:12px;padding:12px 18px;background:#14171de8}.smv-title{flex:1;min-width:0}.smv-title strong,.smv-title small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.smv-title strong{font-size:14px}.smv-title small{font-size:11px;color:#b6bcc7;margin-top:5px}.signal-media-lightbox button{border:1px solid #ffffff28;border-radius:8px;background:#ffffff12;color:inherit;padding:8px 12px;cursor:pointer}.signal-media-lightbox button:hover{background:#ffffff28}.signal-media-lightbox button:focus-visible{outline:2px solid #8caeff;outline-offset:3px}.signal-media-lightbox button:disabled{opacity:.3;cursor:default}.smv-close{font-size:24px;line-height:24px}.smv-content{grid-column:2;grid-row:2;min-height:0;min-width:0;display:flex;align-items:center;justify-content:center;padding:12px}.smv-content img,.smv-content video{max-height:100%;max-width:100%;object-fit:contain}.smv-content audio{width:420px;max-width:100%}.smv-prev,.smv-next{grid-row:2;align-self:center;font-size:36px;margin:8px}.smv-prev{grid-column:1}.smv-next{grid-column:3}.smv-status{grid-column:1/-1;text-align:center;font-size:12px;padding:6px 12px;color:#b8d9c5}.smv-status button{padding:4px 8px;margin-left:8px}@media(max-width:700px){.signal-media-lightbox{grid-template-columns:42px minmax(0,1fr) 42px}.smv-toolbar{padding:8px;gap:6px}.smv-toolbar button{padding:7px}.smv-prev,.smv-next{padding:6px;margin:4px}.smv-title{max-width:38vw}}
</style>
