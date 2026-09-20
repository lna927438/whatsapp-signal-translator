<script setup lang="ts">
import { uiLanguage } from '../lib/uiLocale'
defineProps<{ state: 'idle' | 'loading' | 'ready' | 'error'; message: string; hasWindows: boolean; busy: boolean }>()
const emit = defineEmits<{ add: []; retry: [] }>()
</script>

<template>
  <section class="google-voice-content" :aria-busy="state === 'loading'" aria-label="Google Voice">
    <div v-if="state !== 'ready'" class="voice-start">
      <img :src="'./google-voice.svg'" alt="" />
      <h2>Google Voice</h2>
      <p v-if="state === 'loading'" role="status">{{ uiLanguage === 'en' ? 'Opening your window…' : '正在打开窗口…' }}</p>
      <template v-else-if="state === 'error'">
        <p class="voice-error" role="alert">{{ message }}</p>
        <button type="button" class="primary" :disabled="busy" @click="emit('retry')">{{ uiLanguage === 'en' ? 'Try again' : '重试' }}</button>
      </template>
      <template v-else>
        <p>{{ uiLanguage === 'en' ? 'Add an account window and sign in to Google Voice here. Translation is available in supported text conversations.' : '添加账号窗口，在客户端内登录 Google Voice。进入支持的短信会话后可使用翻译。' }}</p>
        <button type="button" class="primary" :disabled="busy" @click="hasWindows ? emit('retry') : emit('add')">{{ uiLanguage === 'en' ? (hasWindows ? 'Open window' : 'Add window') : (hasWindows ? '打开窗口' : '新增窗口') }}</button>
      </template>
      <small>{{ uiLanguage === 'en' ? 'Google Voice is a trademark of Google LLC.' : 'Google Voice 是 Google LLC 的商标。' }}</small>
    </div>
  </section>
</template>

<style scoped>
.google-voice-content { width: 100%; height: 100%; min-height: 0; background: var(--field); color: var(--text); display: grid; place-items: center; }
.voice-start { max-width: 460px; padding: 28px; text-align: center; }
.voice-start > img { width: 56px; height: 56px; }
.voice-start h2 { margin: 18px 0 12px; font-size: 23px; font-weight: 600; }
.voice-start p { margin: 0 0 22px; color: var(--muted); line-height: 1.7; font-size: 14px; overflow-wrap: anywhere; }
.voice-start .voice-error { color: #f19b92; }
.voice-start button { min-width: 112px; }
.voice-start small { display: block; margin-top: 28px; color: var(--muted); font-size: 11px; }
</style>
