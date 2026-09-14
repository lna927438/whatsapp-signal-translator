<script setup lang="ts">
import { t, uiLanguage, languageName, uiError } from '../lib/uiLocale'

import { ref, watch } from 'vue'
import { normalizeQuality } from '../../../shared/translationPolicy'
const props = defineProps<{ account: any; conversation?: { id: string; name?: string } }>()
const emit = defineEmits(['close','updated'])
const scope = ref(props.conversation?.id ? 'contact' : 'account')
const tone = ref(''), glossary = ref(''), message = ref(''), busy = ref(false), previous = ref<any>(null)
const read = () => scope.value === 'contact' ? props.account.contactLanguages?.[props.conversation!.id]?.translationQuality : props.account.translationQuality
function fill(value: any) { tone.value = value?.tone || ''; glossary.value = (value?.glossary || []).map((item:any)=>item.source+' = '+item.target).join('\n') }
watch(scope, () => { fill(read()); previous.value=null }, {immediate:true})
function parsed() {
  return normalizeQuality({tone:tone.value || undefined,glossary:glossary.value.split(/\r?\n/).filter(line=>line.trim()).map(line=>{
    const at=line.indexOf('=');if(at<1)throw new Error(t('每行请填写：原文 = 译文。'))
    return {source:line.slice(0,at).trim(),target:line.slice(at+1).trim()}
  })})
}
async function importFile(event: Event) {
  const input=event.target as HTMLInputElement, file=input.files?.[0]; if(!file)return
  try { if(file.size>100000)throw new Error(t('术语文件最多 100 KB。'));const text=await file.text()
    if(file.name.endsWith('.json')) { const data=JSON.parse(text);const value=normalizeQuality({glossary:Array.isArray(data)?data:data.glossary});glossary.value=(value?.glossary||[]).map(item=>item.source+' = '+item.target).join('\n') }
    else {glossary.value=text;parsed()}
    message.value=t('已读入，保存后生效。')
  } catch(e:any) {message.value=e.message} finally {input.value=''}
}
async function save(undo=false) {
  if(busy.value)return;busy.value=true
  try {const value=undo?previous.value.quality:parsed();const old=JSON.parse(JSON.stringify(read()||{}))
    const result=scope.value==='contact'?await window.desktopAPI.setContactQuality(props.account.id,props.conversation!.id,value):await window.desktopAPI.updateAccount(props.account.id,{translationQuality:value||{}})
    emit('updated',result);previous.value=undo?null:{quality:old};fill(value);message.value=undo?t('已撤销。'):t('已保存，只影响所选范围。')
  } catch(e:any){message.value=e.message}finally{busy.value=false}
}
</script>
<template>
  <div class="modal-backdrop" @click.self="emit('close')"><section class="panel quality-editor" role="dialog" aria-modal="true" :aria-label="t('语气与术语')">
    <header><h2>{{ t('语气与术语') }}</h2><button :aria-label="t('关闭')" @click="emit('close')">×</button></header>
    <label>{{ t('应用范围') }}<select v-model="scope" :disabled="busy"><option value="account">{{ t('此账号 · ') }}{{ account.label }}</option><option v-if="conversation?.id" value="contact">{{ t('此联系人 · ') }}{{ conversation.name || conversation.id }}</option></select></label>
    <label>{{ t('语气') }}<select v-model="tone"><option value="">{{ t('跟随上一级') }}</option><option value="natural">{{ t('自然') }}</option><option value="business">{{ t('商务') }}</option></select></label>
    <label>{{ t('术语表') }}<textarea v-model="glossary" :placeholder="t('每行：原文 = 译文')" spellcheck="false" /></label>
    <p>{{ t('最多 100 条。此处保存后仅对新的翻译操作生效；已提交或等待结果的请求保持原设置。') }}</p>
    <label class="import">{{ t('导入 TXT / JSON') }}<input type="file" accept=".txt,.json" @change="importFile" /></label>
    <p role="status">{{ uiError(message) }}</p><footer><button v-if="previous" :disabled="busy" @click="save(true)">{{ t('撤销这次修改') }}</button><button class="primary" :disabled="busy" @click="save()">{{ busy ? t('保存中…') : t('保存') }}</button><button @click="emit('close')">{{ t('关闭') }}</button></footer>
  </section></div>
</template>
<style scoped>
.quality-editor{width:min(540px,90vw);max-height:90vh;overflow:auto;padding:24px;box-sizing:border-box}.quality-editor header,.quality-editor footer{display:flex;align-items:center;justify-content:space-between;gap:10px}.quality-editor label{display:block;margin:14px 0}.quality-editor select,.quality-editor textarea{display:block;box-sizing:border-box;width:100%;margin-top:8px;padding:10px;background:var(--field);color:var(--text);border:1px solid var(--border);border-radius:8px}.quality-editor textarea{height:170px;resize:vertical}.quality-editor footer button:not(.primary){padding:9px 13px;border:1px solid var(--border);border-radius:8px;background:var(--raised);color:var(--text);cursor:pointer}.quality-editor p{font-size:12px;line-height:1.6;color:var(--muted)}.import input{display:block;margin-top:8px;max-width:100%}
</style>
