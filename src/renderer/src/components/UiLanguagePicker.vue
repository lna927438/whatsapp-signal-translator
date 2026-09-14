<script setup lang="ts">
import { ref } from 'vue'
import { uiPreference, saveUiLanguage, t } from '../lib/uiLocale'
const busy = ref(false), error = ref('')
async function change(event: Event) {
  const select = event.target as HTMLSelectElement
  if (busy.value) return
  busy.value = true; error.value = ''
  try { await saveUiLanguage(select.value) }
  catch { error.value = t('无法保存界面语言，请重试。'); select.value = uiPreference.value }
  finally { busy.value = false }
}
</script>
<template>
  <div class="ui-language-picker">
    <label><span>{{ t('界面语言') }}</span><select :value="uiPreference" :disabled="busy" aria-label="Language / 语言" @change.stop="change"><option value="system">{{ t('跟随系统') }}</option><option value="en">English</option><option value="zh-CN">简体中文</option></select></label>
    <small v-if="error" role="alert">{{ error }}</small>
  </div>
</template>
<style scoped>
.ui-language-picker{max-width:100%;font-size:13px}.ui-language-picker label{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.ui-language-picker select{max-width:100%;padding:7px 10px;border:1px solid #647781;border-radius:7px;color:inherit;background:transparent}.ui-language-picker option{color:#152127;background:#f4f6f4}.ui-language-picker small{display:block;color:#cd714e;margin-top:5px}
</style>
