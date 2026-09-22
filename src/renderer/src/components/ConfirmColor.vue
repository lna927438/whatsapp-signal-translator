<script setup lang="ts">
import { ref, watch } from 'vue'
import { t, uiError } from '../lib/uiLocale'
const props = defineProps<{ value: string; save: (value: string) => Promise<void> | void; label?: string; disabled?: boolean }>()
const open = ref(false), draft = ref(props.value), busy = ref(false), error = ref('')
watch(() => props.value, value => { if (!open.value) draft.value = value })
function start() { draft.value = props.value; error.value = ''; open.value = true }
function cancel() { if (!busy.value) { draft.value = props.value; error.value = ''; open.value = false } }
async function confirm() {
  if (busy.value || !/^#[a-f0-9]{6}$/i.test(draft.value)) return
  busy.value = true; error.value = ''
  try { await props.save(draft.value); open.value = false }
  catch (e: any) { error.value = uiError(e?.message) || t('颜色未保存，请重试') }
  finally { busy.value = false }
}
</script>
<template>
  <div class="confirm-color" @keydown.esc.stop="cancel">
    <button v-if="!open" type="button" class="color-trigger" :disabled="disabled" @click="start"><span>{{ label || t('译文颜色') }}</span><i :style="{ backgroundColor: value }"></i></button>
    <div v-else class="color-editor" role="group" :aria-label="label || t('译文颜色')">
      <label>{{ t('选择颜色') }}<input v-model="draft" type="color" :disabled="busy" /></label>
      <span class="color-preview" :style="{ color: draft }">{{ t('译文预览') }}</span>
      <button type="button" :disabled="busy" @click="confirm">{{ busy ? t('保存中…') : t('确定') }}</button>
      <button type="button" :disabled="busy" @click="cancel">{{ t('取消') }}</button>
      <span v-if="error" role="alert">{{ error }}</span>
    </div>
  </div>
</template>
<style scoped>
.confirm-color{display:inline-flex;min-width:0}.color-trigger,.color-editor button{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--border,#34414a);border-radius:6px;background:var(--field,#121a20);color:var(--text,#e1e9ef);font-size:12px;cursor:pointer}.color-trigger i{width:17px;height:17px;border:1px solid #83929c;border-radius:4px}.color-editor{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:5px;border:1px solid var(--border,#34414a);border-radius:8px;background:var(--surface,#191e24)}.color-editor label{display:flex;align-items:center;gap:7px;font-size:12px}.color-editor input{width:27px;height:27px;padding:0;border:0}.color-preview{padding:6px 10px;background:#142028;border-radius:5px;font-size:13px}.color-editor [role=alert]{color:#efa99c;font-size:12px}.color-editor button:disabled{opacity:.6;cursor:default}
</style>
