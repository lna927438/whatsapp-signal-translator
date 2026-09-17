<script setup lang="ts">
import { computed, ref } from 'vue'
import { uiError, uiLanguage } from '../lib/uiLocale'

const emit = defineEmits<{ error: [message: string] }>()
const opening = ref(false)
const label = computed(() => uiLanguage.value === 'en' ? 'Google Voice · Official separate window' : 'Google Voice · 官方独立窗口')
const title = computed(() => opening.value ? (uiLanguage.value === 'en' ? 'Opening Google Voice…' : '正在打开 Google Voice…') : label.value)

async function open() {
  if (opening.value) return
  opening.value = true
  try {
    await window.desktopAPI.openGoogleVoice()
  } catch (error: any) {
    emit('error', uiError(error?.message || (uiLanguage.value === 'en' ? 'Google Voice could not be opened. Please try again.' : 'Google Voice 暂时无法打开，请重试。')))
  } finally {
    opening.value = false
  }
}
</script>

<template>
  <button type="button" class="compact-tool google-voice-launcher" :disabled="opening" :aria-busy="opening" :aria-label="label" :title="title" @click="open">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M8 3H4a1 1 0 0 0-1 1c0 9 8 17 17 17a1 1 0 0 0 1-1v-4l-5-1-2 2a17 17 0 0 1-7-7l2-2Z" />
      <path d="M15 3h6v6 M21 3l-7 7" />
    </svg>
  </button>
</template>

<style scoped>
.google-voice-launcher:disabled { opacity: .55; cursor: progress; }
</style>
