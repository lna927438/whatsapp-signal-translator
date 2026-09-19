<script setup lang="ts">
import AccountNavigation from './AccountNavigation.vue'
import UiIcon from './UiIcon.vue'
import { uiLanguage } from '../lib/uiLocale'
import type { GoogleVoiceWindow } from '../lib/googleVoiceWorkspace'

defineProps<{ windows: GoogleVoiceWindow[]; selectedId: string; busy: boolean; loading: boolean }>()
const emit = defineEmits<{ select: [window: GoogleVoiceWindow]; add: []; rename: [window: GoogleVoiceWindow]; close: [window: GoogleVoiceWindow]; reorder: [ids: string[]]; refresh: []; external: []; translation: [] }>()
</script>

<template>
  <AccountNavigation class="google-voice-navigation" :accounts="windows" :selected-id="selectedId" :unread="{}" platform="google-voice" icon-source="./google-voice.svg" position="top" window-labels :close-label="uiLanguage === 'en' ? 'Remove from workspace; keep browser window and sign-in data' : '移出工作台；保留浏览器窗口和登录资料'" :ordering="busy" :busy="busy" @select="emit('select', $event)" @add="emit('add')" @remove="emit('close', $event)" @remark="emit('rename', $event)" @menu="emit('rename', $event)" @reorder="emit('reorder', $event)">
    <template #tools>
      <div class="voice-window-tools">
        <button type="button" class="text-button voice-connect" :disabled="busy || !selectedId" @click="emit('translation')">{{ uiLanguage === 'en' ? 'Connect translation' : '连接翻译' }}</button>
        <button type="button" class="compact-tool" :disabled="busy || !selectedId" :title="uiLanguage === 'en' ? 'Rename window' : '重命名窗口'" :aria-label="uiLanguage === 'en' ? 'Rename window' : '重命名窗口'" @click="emit('rename', windows.find(window => window.id === selectedId)!)">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 3 5 5-12 12-6 1 1-6ZM13 6l5 5" /></svg>
        </button>
        <button type="button" class="compact-tool" :disabled="busy || loading || !selectedId" :title="uiLanguage === 'en' ? 'Reconnect window' : '重新接入窗口'" :aria-label="uiLanguage === 'en' ? 'Reconnect window' : '重新接入窗口'" @click="emit('refresh')"><UiIcon name="refresh" /></button>
        <button type="button" class="compact-tool" :disabled="busy || !selectedId" :title="uiLanguage === 'en' ? 'Open in a separate window' : '在独立窗口中打开'" :aria-label="uiLanguage === 'en' ? 'Open in a separate window' : '在独立窗口中打开'" @click="emit('external')"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3h7v7 M21 3 10 14 M10 3H4v17h17v-7" /></svg></button>
      </div>
    </template>
  </AccountNavigation>
</template>

<style scoped>
.voice-window-tools { display: flex; align-items: center; gap: 2px; }
.voice-window-tools button:disabled { opacity: .45; cursor: default; }
.voice-connect { white-space: nowrap; font-size: 11px; padding: 5px 7px; }
</style>
