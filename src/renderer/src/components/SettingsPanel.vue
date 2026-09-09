<script setup lang="ts">
import { onMounted, ref } from 'vue'
const emit = defineEmits(['close'])
const settings = ref<any>(null)
const languages = ref<any[]>([])
const saving = ref(false)
const testText = ref('Hello, how are you?')
const testResult = ref('')

onMounted(async () => { settings.value = await window.desktopAPI.getSettings(); languages.value = await window.desktopAPI.getLanguages() })
async function save() { saving.value = true; try { await window.desktopAPI.saveSettings(settings.value); emit('close') } finally { saving.value = false } }
async function test() { testResult.value = await window.desktopAPI.testTranslation(testText.value, settings.value.localLanguage) }
</script>
<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section v-if="settings" class="panel">
      <header><h2>Translation Settings</h2><button @click="emit('close')">×</button></header>
      <div class="mode-lock"><span>Mode</span><strong>Precise Translation</strong><small>Fixed</small></div>
      <label>Your language<select v-model="settings.localLanguage"><option v-for="l in languages.filter(x=>x.code!=='auto')" :value="l.code">{{ l.name }}</option></select></label>
      <label>Recipient language<select v-model="settings.targetLanguage"><option v-for="l in languages.filter(x=>x.code!=='auto')" :value="l.code">{{ l.name }}</option></select></label>
      <label>Translation provider<select v-model="settings.provider"><option value="openai">OpenAI</option><option value="deepl">DeepL</option><option value="google">Google Translate</option></select></label>
      <template v-if="settings.provider==='openai'">
        <label>OpenAI API key<input v-model="settings.openaiApiKey" type="password" autocomplete="off" /></label>
        <label>OpenAI model<input v-model="settings.openaiModel" placeholder="gpt-5.6-luna" /></label>
      </template>
      <label v-if="settings.provider==='deepl'">DeepL API key<input v-model="settings.deeplApiKey" type="password" /></label>
      <label v-if="settings.provider==='google'">Google Translate API key<input v-model="settings.googleApiKey" type="password" /></label>
      <div class="toggles"><label><input v-model="settings.receiveAutoTranslate" type="checkbox" /> Automatically translate received messages</label><label><input v-model="settings.sendAutoTranslate" type="checkbox" /> Translate before sending</label></div>
      <div class="test-box"><textarea v-model="testText"></textarea><button @click="test">Test → your language</button><pre v-if="testResult">{{ testResult }}</pre></div>
      <footer><button class="secondary" @click="emit('close')">Cancel</button><button class="primary" :disabled="saving" @click="save">{{ saving ? 'Saving…' : 'Save' }}</button></footer>
    </section>
  </div>
</template>
