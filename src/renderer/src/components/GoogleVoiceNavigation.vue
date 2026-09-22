<script setup lang="ts">
import AccountNavigation from './AccountNavigation.vue'
import UiIcon from './UiIcon.vue'
import { uiLanguage } from '../lib/uiLocale'
import type { GoogleVoiceWindow, GoogleVoiceNetwork } from '../lib/googleVoiceWorkspace'

defineProps<{ windows: GoogleVoiceWindow[]; selectedId: string; busy: boolean; loading: boolean; canGoBack?:boolean; network?:GoogleVoiceNetwork; unread?:Record<string,number> }>()
const emit = defineEmits<{ select: [window: GoogleVoiceWindow]; add: []; rename: [window: GoogleVoiceWindow]; close: [window: GoogleVoiceWindow]; reorder: [ids: string[]]; refresh: []; back: []; translation: []; network: [] }>()
</script>

<template>
  <AccountNavigation class="google-voice-navigation" :accounts="windows" :selected-id="selectedId" :unread="unread || {}" platform="google-voice" icon-source="./google-voice.svg" position="top" window-labels :close-label="uiLanguage === 'en' ? 'Close account window; keep sign-in data' : '关闭账号窗口；保留登录资料'" :ordering="busy" :busy="busy" @select="emit('select', $event)" @add="emit('add')" @remove="emit('close', $event)" @rename="emit('rename', $event)" @menu="emit('rename', $event)" @reorder="emit('reorder', $event)">
    <template #tools>
      <div class="voice-window-tools">
        <button type="button" class="text-button voice-network" :class="{failed:network?.status === 'error'}" :disabled="busy || !selectedId" :title="uiLanguage === 'en' ? 'Window proxy and last checked exit IP' : '窗口代理与最近检测的出口 IP'" aria-label="IP settings" @click="emit('network')">{{ network?.status === 'checked' ? 'IP ' + network.ip : network?.status === 'checking' ? (uiLanguage === 'en' ? 'Checking IP…' : '检测 IP…') : network?.status === 'error' ? (uiLanguage === 'en' ? 'Check IP' : 'IP 待检查') : (uiLanguage === 'en' ? 'IP settings' : 'IP 设置') }}</button>
        <button type="button" class="text-button voice-connect" :disabled="busy || !selectedId" @click="emit('translation')">{{ uiLanguage === 'en' ? 'Voice settings' : '翻译与通话' }}</button>
        <button type="button" class="compact-tool" :disabled="busy || !selectedId" :title="uiLanguage === 'en' ? 'Rename window' : '重命名窗口'" :aria-label="uiLanguage === 'en' ? 'Rename window' : '重命名窗口'" @click="emit('rename', windows.find(window => window.id === selectedId)!)">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 3 5 5-12 12-6 1 1-6ZM13 6l5 5" /></svg>
        </button>
        <button type="button" class="compact-tool" :disabled="busy || !selectedId" :title="uiLanguage === 'en' ? 'Reload page' : '重新加载页面'" :aria-label="uiLanguage === 'en' ? 'Reload page' : '重新加载页面'" @click="emit('refresh')"><UiIcon name="refresh" /></button>
        <button type="button" class="compact-tool" :disabled="busy || !selectedId || !canGoBack" :title="uiLanguage === 'en' ? 'Back' : '返回上一页'" :aria-label="uiLanguage === 'en' ? 'Back' : '返回上一页'" @click="emit('back')"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5m7-7-7 7 7 7" /></svg></button>
      </div>
    </template>
  </AccountNavigation>
</template>

<style scoped>
.voice-window-tools { display: flex; align-items: center; gap: 2px; }
.voice-window-tools button:disabled { opacity: .45; cursor: default; }
.voice-connect { white-space: nowrap; font-size: 11px; padding: 5px 7px; }
.voice-network { max-width:155px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px;padding:5px 7px }.voice-network.failed{color:#f1a499}
</style>
