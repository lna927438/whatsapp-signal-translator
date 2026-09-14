<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { mediaKind, signalMediaEntries } from '../../../shared/signalMedia'
import SignalMedia from './SignalMedia.vue'
import { t, uiLanguage } from '../lib/uiLocale'
const props = defineProps<{ accountId: string; peer: string; messages: any[] }>()
const tab = ref('media'), limit = ref(60)
const entries = computed(() => signalMediaEntries(props.messages))
const pictures = computed(() => entries.value.filter(item => ['image', 'video'].includes(mediaKind(item.contentType))))
const files = computed(() => entries.value.filter(item => !['image', 'video'].includes(mediaKind(item.contentType))))
const links = computed(() => [...new Set(props.messages.filter(message => !message.expired && (!message.expiresAt || message.expiresAt > Date.now())).flatMap(message => String(message.original || '').match(/https?:\/\/[^\s<>]+/g) || []))])
const groups = computed(() => {
  const result = new Map<string, typeof pictures.value>()
  for (const item of pictures.value.slice(0, limit.value)) {
    const label = new Date(item.timestamp).toLocaleDateString(uiLanguage.value, { year: 'numeric', month: 'long' })
    if (!result.has(label)) result.set(label, [])
    result.get(label)!.push(item)
  }
  return [...result].map(([label, items]) => ({ label, items }))
})
function host(link: string) { try { return new URL(link).hostname } catch { return link } }
watch(() => [props.accountId, props.peer], () => { tab.value = 'media'; limit.value = 60 })
</script>
<template>
  <section class="signal-gallery" :aria-label="t('媒体、链接和文件')">
    <div class="sg-tabs" role="tablist">
      <button v-for="item in [{id:'media',name:t('媒体'),count:pictures.length},{id:'links',name:t('链接'),count:links.length},{id:'files',name:t('文件'),count:files.length}]" :key="item.id" role="tab" :aria-selected="tab === item.id" :class="{active:tab === item.id}" @click="tab = item.id; limit = 60">{{ item.name }} <small>{{ item.count }}</small></button>
    </div>
    <div v-if="tab === 'media'" role="tabpanel" :aria-label="t('媒体')">
      <p v-if="!pictures.length" class="sg-empty">{{ t('此设备尚未保存这段对话的照片或视频。') }}</p>
      <section v-for="group in groups" :key="group.label" class="sg-month"><h3>{{ group.label }}</h3><div class="sg-grid"><SignalMedia v-for="item in group.items" :key="item.key" :account-id="accountId" :peer="item.peer" :attachment="item" :timestamp="item.timestamp" :gallery="pictures" thumbnail /></div></section>
      <button v-if="pictures.length > limit" class="sg-more" @click="limit += 60">{{ t('加载更多') }}</button>
    </div>
    <div v-else-if="tab === 'links'" role="tabpanel" :aria-label="t('链接')"><p v-if="!links.length" class="sg-empty">{{ t('没有链接。') }}</p><a v-for="link in links.slice(0,limit)" :key="link" class="sg-link" :href="link" target="_blank" rel="noreferrer noopener"><strong>{{ host(link) }}</strong><span>{{ link }}</span></a><button v-if="links.length > limit" class="sg-more" @click="limit += 60">{{ t('加载更多') }}</button></div>
    <div v-else role="tabpanel" :aria-label="t('文件')"><p v-if="!files.length" class="sg-empty">{{ t('没有文件。') }}</p><div v-for="item in files.slice(0,limit)" :key="item.key" class="sg-file"><SignalMedia :account-id="accountId" :peer="item.peer" :attachment="item" /><time>{{ new Date(item.timestamp).toLocaleDateString(uiLanguage) }}</time></div><button v-if="files.length > limit" class="sg-more" @click="limit += 60">{{ t('加载更多') }}</button></div>
  </section>
</template>
<style scoped>
.signal-gallery{min-width:0}.sg-tabs{display:flex;gap:4px;padding:0 0 12px;border-bottom:1px solid var(--signal-border,#343b47)}.sg-tabs button{flex:1;white-space:nowrap;background:transparent;color:var(--signal-muted,#aeb5c4);border:0;border-radius:7px;padding:9px 3px;cursor:pointer;font-size:12px}.sg-tabs button.active{background:var(--signal-button,#303746);color:var(--signal-text,#fff)}.sg-tabs small{font-size:10px;opacity:.75}.sg-month h3{font-size:12px;font-weight:500;color:var(--signal-muted,#aeb5c4);margin:18px 0 9px}.sg-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px}.sg-empty{padding:25px 5px;font-size:12px;line-height:1.7;color:var(--signal-muted,#aeb5c4)}.sg-link{display:block;padding:14px 0;border-bottom:1px solid var(--signal-border,#343b47);text-decoration:none;overflow-wrap:anywhere}.sg-link strong{display:block;color:var(--signal-text,#fff);font-size:12px}.sg-link span{display:block;font-size:11px;color:#90b4ff;margin-top:5px}.sg-file{border-bottom:1px solid var(--signal-border,#343b47);padding:8px 0 14px}.sg-file time{font-size:10px;color:var(--signal-muted,#aeb5c4)}.sg-more{width:100%;margin-top:16px;background:var(--signal-button,#303746);color:inherit;border:0;padding:10px;border-radius:7px;cursor:pointer}.sg-tabs button:focus-visible,.sg-more:focus-visible{outline:2px solid #8aabff;outline-offset:2px}
</style>
