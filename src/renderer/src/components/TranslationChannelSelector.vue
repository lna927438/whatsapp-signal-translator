<script setup lang="ts">
import { ref } from 'vue'
import { translationModelLabel, type TranslationChannelStatus } from '../../../shared/translationChannels'
import { t, uiError } from '../lib/uiLocale'
type Provider = 'deepseek' | 'openai'
type Channels = Record<Provider, TranslationChannelStatus>
const props = defineProps<{ value: Provider | ''; channels: Channels; save: (provider: Provider) => Promise<void>; loading?: boolean }>()
const busy = ref(false), message = ref(''), failed = ref(false)
async function choose(provider: Provider) {
  if (busy.value || props.loading || !props.channels[provider].available || provider === props.value) return
  busy.value = true; failed.value = false; message.value = t('正在切换…')
  try { await props.save(provider); message.value = t('已切换，仅此窗口生效') }
  catch (error: any) { failed.value = true; message.value = uiError(error?.message) || t('切换未完成，保留原通道') }
  finally { busy.value = false }
}
</script>
<template>
  <div class="channel-control" :aria-busy="busy || loading">
    <span class="channel-label">{{ t('翻译通道') }}</span>
    <div class="channel-buttons" role="group" :aria-label="t('此窗口的翻译通道')">
      <button v-for="provider in (['deepseek','openai'] as const)" :key="provider" type="button" :aria-pressed="value === provider" :disabled="busy || loading || !channels[provider].available" :title="channels[provider].reason || t('仅对此窗口的新翻译生效')" @click="choose(provider)">{{ translationModelLabel(provider, channels[provider]) }}<small v-if="!channels[provider].available">{{ t('暂不可用') }}</small></button>
    </div>
    <span v-if="message" class="channel-message" :class="{ failed }" :role="failed ? 'alert' : 'status'">{{ message }}</span>
    <span v-else-if="!channels.openai.available" class="channel-message">OpenAI · {{ channels.openai.reason || t('OpenAI 尚未启用') }}</span>
  </div>
</template>
<style scoped>
.channel-control{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0;padding:7px 12px;background:var(--surface,#191e24);border-bottom:1px solid var(--border,#303a42);font-size:12px;flex:0 0 auto}.channel-label{color:var(--muted,#a7b3bd)}.channel-buttons{display:flex;gap:3px;padding:3px;background:var(--field,#10171d);border:1px solid var(--border,#303a42);border-radius:8px}.channel-buttons button{border:0;border-radius:5px;padding:5px 11px;color:var(--muted,#a7b3bd);background:transparent;cursor:pointer;font-size:12px}.channel-buttons button[aria-pressed=true]{background:var(--accent-soft,#27443b);color:var(--text,#e2ece6)}.channel-buttons button:disabled{cursor:default;opacity:.65}.channel-buttons small{margin-left:6px;font-size:10px}.channel-message{color:var(--muted,#a7b3bd);font-size:11px}.channel-message.failed{color:#efa99c}
</style>
