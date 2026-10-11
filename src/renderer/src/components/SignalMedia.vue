<script setup lang="ts">
import { t, uiError } from '../lib/uiLocale'

import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { mediaKind, signalAttachmentFilename, type SignalAttachment, type SignalMediaEntry, type SignalMediaAction, type SignalMediaActionResult } from '../../../shared/signalMedia'
import SignalMediaViewer from './SignalMediaViewer.vue'
import { voiceAudioWav } from '../../../shared/voiceAudio'
const props = defineProps<{ accountId: string; peer: string; attachment: SignalAttachment; staged?: boolean; thumbnail?: boolean; gallery?: SignalMediaEntry[]; timestamp?: number }>()
const kind = computed(() => mediaKind(props.attachment.contentType)), url = ref(''), error = ref(''), busy = ref(false), expanded = ref(false), element = ref<HTMLElement>()
const saving = ref(false), notice = ref('')
const voiceBusy=ref(false),voiceError=ref(''),voiceOutput=ref(''),voiceEnglish=ref('')
const filename = computed(() => signalAttachmentFilename(props.attachment))
const ownEntry = computed<SignalMediaEntry>(() => ({ ...props.attachment, filename: filename.value, peer: props.peer, timestamp: props.timestamp || 0, key: JSON.stringify([props.peer, props.timestamp || 0, props.attachment.id]) }))
const galleryItems = computed(() => props.gallery?.length ? props.gallery : [ownEntry.value])
const selectedKey = computed(() => galleryItems.value.find(item => item.id === props.attachment.id && item.peer === props.peer && (!props.timestamp || item.timestamp === props.timestamp))?.key || ownEntry.value.key)
let observer: IntersectionObserver | undefined, disposed = false, revision = 0, visible = false
let returnFocus: HTMLElement | undefined
const identity = computed(() => JSON.stringify([props.accountId, props.peer, props.attachment.id, props.attachment.contentType, props.timestamp || 0, props.staged]))
async function load() {
  if (busy.value || kind.value === 'file') return
  const current = ++revision
  busy.value = true; error.value = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const value = await Promise.race([window.desktopAPI.signalMediaUrl(props.accountId, props.peer, props.attachment.id, props.staged),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(t('附件读取超时，可重试。'))), 10000) })])
    if (!disposed && current === revision) url.value = value
  }
  catch (e:any) { if (!disposed && current === revision) error.value = e.message || t('附件暂时无法打开') }
  finally { clearTimeout(timer); if (current === revision) busy.value = false }
}
async function act(action: SignalMediaAction) {
  if (props.staged) return
  if (saving.value) return
  const current = identity.value
  saving.value = true; notice.value = ''; error.value = ''
  try {
    const result: SignalMediaActionResult = await window.desktopAPI.signalMediaAction(props.accountId, props.peer, props.attachment.id, action)
    if (!disposed && current === identity.value && result.success) notice.value = result.action === 'copy' ? t('图片已复制') : t('附件已保存')
  }
  catch (e:any) { if (!disposed && current === identity.value) error.value = e.message || t('附件未保存，可重试。') }
  finally { if (current === identity.value) saving.value = false }
}
function openImage() { returnFocus = document.activeElement as HTMLElement; expanded.value = true }
async function translateVoice(){
 if(voiceBusy.value||voiceOutput.value||!url.value||props.staged||props.thumbnail)return
 const current=identity.value,version=revision;voiceBusy.value=true;voiceError.value=''
 try{
  const bytes=await voiceAudioWav(url.value);if(disposed||version!==revision||current!==identity.value)return
  const result=await window.desktopAPI.translateVoiceMessage(props.accountId,{bytes,conversationId:props.peer,messageId:'voice:'+JSON.stringify([props.peer,props.attachment.id,props.timestamp||0])})
  if(disposed||version!==revision||current!==identity.value)return
  if(result?.targetLanguage!=='zh-CN'||typeof result.translation!=='string'||!result.translation.trim()||result.translation.length>40000||typeof result.englishTranslation!=='string'||!result.englishTranslation.trim()||result.englishTranslation.length>40000)throw new Error(t('翻译失败，请重试。'))
  voiceOutput.value=result.translation;voiceEnglish.value=result.englishTranslation
 }
 catch(e:any){if(!disposed&&version===revision&&current===identity.value)voiceError.value=e.message||t('语音暂未转为中文，请稍后重试。原语音已保留。')}
 finally{if(version===revision&&current===identity.value)voiceBusy.value=false}
}
function closeImage() { expanded.value = false; if (returnFocus?.isConnected) returnFocus.focus(); returnFocus = undefined }
watch(identity, () => { revision++; url.value = ''; error.value = ''; notice.value = ''; busy.value = false; saving.value = false;voiceBusy.value=false;voiceError.value='';voiceOutput.value='';voiceEnglish.value=''; closeImage(); if (visible) void load() })
onMounted(() => {
  if (typeof IntersectionObserver === 'undefined') { visible = true; void load(); return }
  observer = new IntersectionObserver(entries => { if (entries.some(item => item.isIntersecting)) { visible = true; observer?.disconnect(); void load() } }, { rootMargin: '200px' })
  if (element.value) observer.observe(element.value)
})
onUnmounted(() => { disposed = true; revision++; observer?.disconnect(); closeImage() })
</script>
<template>
  <div ref="element" class="signal-media" :class="['media-' + kind, { 'media-thumbnail': thumbnail }]" @contextmenu.prevent="act('menu')">
    <button v-if="url && kind === 'image'" class="media-image" :aria-label="t('查看图片 ') + filename" @click="openImage"><img :src="url" :alt="filename" loading="lazy" @error="error = t('图片加载失败，可重试或保存')" /></button>
    <button v-else-if="url && kind === 'video' && thumbnail" class="media-image media-video-thumb" :aria-label="t('查看视频 ') + filename" @click="openImage"><video :src="url" preload="metadata" muted playsinline /><span aria-hidden="true">▶</span></button>
    <video v-else-if="url && kind === 'video'" :src="url" controls preload="metadata" playsinline @error="error = t('此视频无法播放，可保存后打开')" />
    <audio v-else-if="url && kind === 'audio'" :src="url" controls preload="metadata" @error="error = t('此音频无法播放，可保存后打开')" />
    <span v-else-if="busy" class="media-loading">{{ t('正在读取附件…') }}</span>
    <div v-if="!thumbnail" class="media-caption"><span>{{ attachment.isVoiceNote ? t('语音消息') : filename }} <small>{{ attachment.size >= 1048576 ? (attachment.size / 1048576).toFixed(1) + ' MB' : Math.ceil(attachment.size / 1024) + ' KB' }}</small></span><button v-if="!staged" :disabled="saving" :title="t('保存附件')" @click="act('save')">↓</button></div>
    <div v-if="kind==='audio'&&!staged&&!thumbnail" class="voice-review">
      <button v-if="!voiceOutput" :disabled="voiceBusy||!url" @click="translateVoice">{{t(voiceBusy?'正在转为中文…':voiceError?'重试语音翻译':'转为中文')}}</button>
      <p v-if="voiceError" role="status">{{uiError(voiceError)}}</p>
      <p v-if="voiceEnglish" class="voice-output" lang="en" :aria-label="t('英文译文')">{{voiceEnglish}}</p>
      <p v-if="voiceOutput" class="voice-output" lang="zh-CN" role="status" :aria-label="t('语音中文译文')">{{voiceOutput}}</p>
      <p v-else-if="!voiceError&&!voiceBusy">{{t('点击后在语音下方显示英文和中文。')}}</p>
    </div>
    <p v-if="error" role="status">{{ uiError(error) }} <button v-if="kind !== 'file'" @click="load">{{ t('重试') }}</button></p>
    <p v-else-if="notice" class="media-notice" role="status">{{ notice }}</p>
    <SignalMediaViewer v-if="expanded" :account-id="accountId" :items="galleryItems" :selected-key="selectedKey" :staged="staged" @close="closeImage" />
  </div>
</template>
<style scoped>
.signal-media{max-width:400px;min-width:160px;white-space:normal;margin-top:6px}.media-image{border:0;background:transparent;padding:0;cursor:zoom-in;display:block;max-width:100%}.media-image img,video{display:block;max-width:100%;max-height:360px;border-radius:10px;object-fit:contain}audio{width:300px;max-width:100%}.media-caption{display:flex;align-items:center;gap:8px;font-size:11px;padding:5px 0}.media-caption>span{flex:1;overflow-wrap:anywhere}.media-caption small{opacity:.7;white-space:nowrap}.media-caption button,.signal-media p button{background:#ffffff20;color:inherit;border:0;border-radius:6px;padding:5px 9px;cursor:pointer}.signal-media p{font-size:11px;color:#e5ae85;margin:4px 0}.media-loading{font-size:11px;opacity:.7}</style>
<style scoped>
.media-thumbnail{min-width:0;max-width:none;width:100%;height:100%;aspect-ratio:1;margin:0;position:relative;background:var(--signal-input,#272b34);border-radius:8px;overflow:hidden}.media-thumbnail .media-image{width:100%;height:100%;max-width:none}.media-thumbnail img,.media-thumbnail video{width:100%;height:100%;max-height:none;object-fit:cover;border-radius:0}.media-thumbnail .media-loading{display:block;padding:10px;font-size:10px}.media-thumbnail p{padding:6px;position:absolute;inset:auto 0 0;background:#181a20dc}.media-video-thumb{position:relative}.media-video-thumb>span{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);background:#0008;color:white;padding:7px 10px;border-radius:50%}.media-notice{color:#8bc8a0!important}
</style>
<style scoped>.voice-review{padding:6px 0}.voice-review button{color:inherit;background:transparent;border:1px solid #8886;border-radius:6px;padding:4px 8px}.voice-review .voice-output{white-space:pre-wrap;overflow-wrap:anywhere;color:inherit;font-size:13px;line-height:1.5;margin:6px 0}</style>
