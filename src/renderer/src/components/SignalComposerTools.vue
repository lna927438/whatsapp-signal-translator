<script setup lang="ts">
import { t, uiLanguage, languageName, uiError } from '../lib/uiLocale'

import { computed, onUnmounted, ref, watch } from 'vue'
import SignalMedia from './SignalMedia.vue'
import { signalVoiceWav } from '../lib/signalVoice'
import { SIGNAL_FILE_COUNT, SIGNAL_FILE_LIMIT, type SignalAttachment } from '../../../shared/signalMedia'
const props = defineProps<{ accountId: string; scopeKey: string; peer: string; disabled?: boolean }>()
const emit = defineEmits(['insert','change','busy'])
const attachments = ref<SignalAttachment[]>([]), busy = ref(false), error = ref(''), emojiOpen = ref(false), emojiSearch = ref(''), category = ref(0), recording = ref(false), seconds = ref(0)
let recorder: MediaRecorder | undefined, stream: MediaStream | undefined, timer: ReturnType<typeof setInterval> | undefined, cancelled = false
const groups = computed(() => ([
  { name:t('笑脸'), symbols:'😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😋 😛 😜 🤪 🤨 🧐 🤓 😎 🥳 😏 😒 😔 😕 🙁 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤯 😳 🥵 🥶 😱 😨 😰 😥 🤗 🤔 🤭 🤫 🤥 😶 😐 😑 🙄 😬 😮 😴 🤤 😷 🤒 🤕 🤢 🤮 🤧 😵 🤠 🤑 👻 💀 🤖 💩' },
  { name:t('手势与爱心'), symbols:'👍 👎 👏 🙌 👐 🤲 🤝 🙏 ✌️ 🤞 🤟 🤘 👌 🤏 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 👋 🤙 💪 🖕 ✍️ 🫶 ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💯 💢 💥 💫 💦 💨' },
  { name:t('生活'), symbols:'🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦄 🐝 🦋 🌸 🌹 🌻 🌲 🌴 🌵 🍀 🌎 🌞 🌙 ⭐ 🌈 🔥 💧 🌊 🍎 🍊 🍋 🍉 🍇 🍓 🍒 🍑 🍍 🥑 🍔 🍟 🍕 🍝 🍣 🍦 🎂 🍫 🍿 ☕ 🍵 🍺 🍷 🥂 ⚽ 🏀 🎾 🏆 🎯 🎉 🎁 🎈 🎵 🎶 🎤 🎧 🚗 ✈️ 🚀 🏠 🏖️ 💻 📱 📷 💡 💰 📚 ✅ ❌ ❓ ❗' }
]))
const emojis = computed(() => groups.value[category.value].symbols.split(' ').filter(value => !emojiSearch.value || value.includes(emojiSearch.value)))
const key = (scope: string) => 'hellodog-signal-media-draft:' + scope
function save(scope = props.scopeKey, files = attachments.value) { localStorage.setItem(key(scope), JSON.stringify(files.map(file => file.id))) }
function publish() { emit('change', [...attachments.value]); save() }
watch(() => props.scopeKey, async value => {
  stopRecording(true); attachments.value = []; emit('change', []); error.value = ''; emojiOpen.value = false
  try {
    const ids = JSON.parse(localStorage.getItem(key(value)) || '[]')
    if (ids.length) { const files = await window.desktopAPI.signalStagedMedia(props.accountId, ids); if (value === props.scopeKey) { attachments.value = files; emit('change', files) } }
  } catch { if (value === props.scopeKey) error.value = t('有附件无法恢复，请重新选择。') }
}, { immediate: true, flush: 'sync' })
watch([busy, recording], () => emit('busy', busy.value || recording.value), { flush:'sync' })
function add(scope: string, files: SignalAttachment[]) {
  if (scope !== props.scopeKey) { const ids = JSON.parse(localStorage.getItem(key(scope)) || '[]'); localStorage.setItem(key(scope), JSON.stringify([...ids, ...files.map(file => file.id)].slice(0,SIGNAL_FILE_COUNT))); return }
  attachments.value = [...attachments.value, ...files].slice(0,SIGNAL_FILE_COUNT); publish()
}
async function pick() {
  if (busy.value || props.disabled) return
  const scope = props.scopeKey; busy.value = true; error.value = ''
  try { add(scope, await window.desktopAPI.signalPickMedia(props.accountId)) } catch (e:any) { error.value = e.message } finally { busy.value = false }
}
async function acceptFiles(files: File[]) {
  if (busy.value || props.disabled || !files.length) return
  const scope = props.scopeKey, accountId = props.accountId
  busy.value = true; error.value = ''
  try {
    if (files.length + attachments.value.length > SIGNAL_FILE_COUNT) throw new Error(t('每条消息最多 16 个附件。'))
    for (const file of files) {
      if (file.size > SIGNAL_FILE_LIMIT) throw new Error(t('请选择 100 MB 以内的文件。'))
      add(scope, [await window.desktopAPI.signalStageMedia(accountId, { bytes: new Uint8Array(await file.arrayBuffer()), filename: file.name })])
    }
  } catch (e:any) { error.value = e.message } finally { busy.value = false }
}
function acknowledge(ids: string[]) { attachments.value = attachments.value.filter(file => !ids.includes(file.id)); publish() }
function remove(id: string) { acknowledge([id]) }
function insert(emoji: string) { emit('insert', emoji) }
function releaseRecording() { clearInterval(timer); stream?.getTracks().forEach(track => track.stop()); stream = undefined; recording.value = false; recorder = undefined }
function stopRecording(cancel = false) { cancelled = cancel; if (recorder?.state === 'recording') recorder.stop(); else releaseRecording() }
async function record() {
  if (recording.value) { stopRecording(); return }
  const scope = props.scopeKey, accountId = props.accountId
  error.value = ''; busy.value = true
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    if (scope !== props.scopeKey) { releaseRecording(); return }
    const chunks: Blob[] = []; let size = 0
    recorder = new MediaRecorder(stream, { mimeType:'audio/webm;codecs=opus' }); cancelled = false; seconds.value = 0
    recorder.ondataavailable = event => { chunks.push(event.data); size += event.data.size; if (size > 20 * 1024 * 1024) stopRecording(true) }
    recorder.onstop = async () => {
      const discard = cancelled; releaseRecording()
      if (discard) return
      busy.value = true
      try { const recording = new Blob(chunks, {type:'audio/webm'}); if (recording.size) { const blob = await signalVoiceWav(recording); add(scope, [await window.desktopAPI.signalStageMedia(accountId, { bytes: new Uint8Array(await blob.arrayBuffer()), filename:t('语音-') + Date.now() + '.wav', voiceNote:true })]) } }
      catch(e:any) { error.value = e.message } finally { busy.value = false }
    }
    recorder.start(1000); recording.value = true; timer = setInterval(() => { seconds.value++; if (seconds.value >= 300) stopRecording() },1000)
  } catch { releaseRecording(); error.value = t('无法使用麦克风，请检查系统麦克风权限。') } finally { busy.value = false }
}
onUnmounted(() => stopRecording(true))
defineExpose({ acknowledge, acceptFiles })
</script>
<template>
  <div class="signal-composer-tools">
    <div v-if="attachments.length" class="signal-selected-media"><div v-for="file in attachments" :key="file.id" class="signal-selected-item"><SignalMedia :account-id="accountId" :peer="peer" :attachment="file" staged /><button :aria-label="t('移除 ') + file.filename" @click="remove(file.id)">×</button></div></div>
    <div class="signal-composer-toolbar"><button :disabled="disabled" :title="t('表情符号')" :aria-label="t('表情符号')" @click="emojiOpen = !emojiOpen">☺</button><button :disabled="disabled || busy || recording" :title="t('添加图片、视频或附件')" :aria-label="t('添加附件')" @click="pick">＋</button><button :disabled="disabled || busy" :title="recording ? t('完成录音') : t('录制语音')" :aria-label="recording ? t('完成录音') : t('录制语音')" @click="record">{{ recording ? '■' : '♩' }}</button><span v-if="recording">{{ t('录音 ') }}{{ seconds }}{{ t(' 秒 ') }}<button @click="stopRecording(true)">{{ t('取消') }}</button></span><small v-if="busy">{{ t('正在准备附件…') }}</small><small v-if="attachments.length">{{ attachments.length }}{{ t(' 个附件') }}</small></div>
    <div v-if="emojiOpen" class="signal-emoji-picker"><header><button v-for="(group,index) in groups" :key="index" :class="{active: category === index}" @click="category = index">{{ group.name }}</button><button :aria-label="t('关闭表情')" @click="emojiOpen = false">×</button></header><div><button v-for="emoji in emojis" :key="emoji" :aria-label="emoji" @click="insert(emoji)">{{ emoji }}</button></div></div>
    <p v-if="error" role="status">{{ uiError(error) }}</p>
  </div>
</template>
<style scoped>
.signal-composer-tools{position:relative;flex-shrink:0;padding:0 12px;background:var(--signal-bg)}.signal-composer-toolbar{display:flex;align-items:center;gap:4px;min-height:34px}.signal-composer-toolbar>button{border:0;background:transparent;color:var(--signal-text);font-size:24px;padding:0 8px;cursor:pointer}.signal-composer-toolbar small,.signal-composer-toolbar span{font-size:11px;color:var(--signal-muted);margin-left:6px}button:disabled{opacity:.4}.signal-selected-media{display:flex;overflow-x:auto;gap:10px;padding:8px 0;max-height:185px}.signal-selected-item{position:relative;flex-shrink:0;width:180px;overflow:hidden;border:1px solid var(--signal-border);border-radius:9px;padding:6px}.signal-selected-item :deep(.signal-media){min-width:0;max-width:100%;margin:0}.signal-selected-item :deep(img),.signal-selected-item :deep(video){max-height:95px;margin:auto}.signal-selected-item>button{position:absolute;right:4px;top:4px;border:0;border-radius:50%;width:23px;height:23px;background:#222c;color:white;cursor:pointer}.signal-emoji-picker{position:absolute;bottom:100%;left:12px;max-width:calc(100% - 24px);width:350px;z-index:18;border:1px solid var(--signal-border);border-radius:12px;background:var(--signal-side);box-shadow:0 6px 25px #0005;padding:8px}.signal-emoji-picker header{display:flex;gap:3px;justify-content:space-between;border-bottom:1px solid var(--signal-border);padding-bottom:6px}.signal-emoji-picker header button{border:0;background:transparent;color:var(--signal-text);font-size:11px;padding:6px;border-radius:6px;cursor:pointer}.signal-emoji-picker header button.active{background:var(--signal-selected)}.signal-emoji-picker>div{display:grid;grid-template-columns:repeat(8,1fr);max-height:230px;overflow:auto;padding-top:6px}.signal-emoji-picker>div button{border:0;background:transparent;border-radius:6px;font-size:24px;padding:4px;cursor:pointer}.signal-emoji-picker>div button:hover{background:var(--signal-selected)}.signal-composer-tools>p{font-size:11px;color:#e9a47e;margin:3px 0}
</style>
