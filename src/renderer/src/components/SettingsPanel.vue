<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

const emit = defineEmits(['close'])
const settings = ref<any>(null)
const languages = ref<any[]>([])
const saving = ref(false)
const testing = ref(false)
const showApiKey = ref(false)
const testText = ref('Hello, how are you?')
const testResult = ref('')
const apiState = ref<'idle' | 'success' | 'error'>('idle')
const apiMessage = ref('')

const configuredKey = computed(() => {
  if (!settings.value) return ''
  if (settings.value.provider === 'openai') return String(settings.value.openaiApiKey || '').trim()
  if (settings.value.provider === 'deepl') return String(settings.value.deeplApiKey || '').trim()
  return String(settings.value.googleApiKey || '').trim()
})

const providerLabel = computed(() => {
  if (!settings.value) return ''
  if (settings.value.provider === 'openai') return 'OpenAI'
  if (settings.value.provider === 'deepl') return 'DeepL'
  return 'Google Cloud Translation'
})

function settingsSnapshot(): any {
  // Vue makes the settings object reactive. Electron IPC cannot clone a Vue
  // Proxy, so always send a plain serializable object across the bridge.
  const snapshot = JSON.parse(JSON.stringify(settings.value || {}))
  if (typeof snapshot.openaiApiKey === 'string') snapshot.openaiApiKey = snapshot.openaiApiKey.trim()
  if (typeof snapshot.deeplApiKey === 'string') snapshot.deeplApiKey = snapshot.deeplApiKey.trim()
  if (typeof snapshot.googleApiKey === 'string') snapshot.googleApiKey = snapshot.googleApiKey.trim()
  return snapshot
}

onMounted(async () => {
  settings.value = await window.desktopAPI.getSettings()
  languages.value = await window.desktopAPI.getLanguages()
})

watch(() => settings.value?.provider, () => {
  apiState.value = 'idle'
  apiMessage.value = ''
  testResult.value = ''
})

async function testApi() {
  if (!configuredKey.value) {
    apiState.value = 'error'
    apiMessage.value = `${providerLabel.value} API key is required.`
    testResult.value = ''
    return
  }

  testing.value = true
  apiState.value = 'idle'
  apiMessage.value = 'Testing API connection and translation…'
  testResult.value = ''
  try {
    const current = settingsSnapshot()
    const result = await window.desktopAPI.testTranslationConfig(current, testText.value, current.localLanguage)
    if (result.ok) {
      apiState.value = 'success'
      apiMessage.value = result.message || 'API connection succeeded.'
      testResult.value = result.translated || ''
    } else {
      apiState.value = 'error'
      apiMessage.value = result.message || 'API connection failed.'
    }
  } catch (error: any) {
    apiState.value = 'error'
    apiMessage.value = error.message || String(error)
  } finally {
    testing.value = false
  }
}

async function save() {
  if ((settings.value.receiveAutoTranslate || settings.value.sendAutoTranslate) && !configuredKey.value) {
    apiState.value = 'error'
    apiMessage.value = `${providerLabel.value} API key is required while automatic translation is enabled.`
    return
  }

  saving.value = true
  try {
    const current = settingsSnapshot()
    await window.desktopAPI.saveSettings(current)
    settings.value = current
    emit('close')
  } catch (error: any) {
    apiState.value = 'error'
    apiMessage.value = error.message || String(error)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section v-if="settings" class="panel">
      <header><h2>Translation Settings</h2><button @click="emit('close')">×</button></header>

      <div class="mode-lock"><span>Mode</span><strong>Precise Translation</strong><small>Fixed</small></div>

      <label>Your language
        <select v-model="settings.localLanguage">
          <option v-for="language in languages.filter(x => x.code !== 'auto')" :key="language.code" :value="language.code">{{ language.name }}</option>
        </select>
      </label>

      <label>Recipient language
        <select v-model="settings.targetLanguage">
          <option v-for="language in languages.filter(x => x.code !== 'auto')" :key="language.code" :value="language.code">{{ language.name }}</option>
        </select>
      </label>

      <label>Translation provider
        <select v-model="settings.provider">
          <option value="openai">OpenAI</option>
          <option value="deepl">DeepL</option>
          <option value="google">Google Cloud Translation</option>
        </select>
      </label>

      <div v-if="settings.provider === 'openai'" class="api-section">
        <div class="api-help">
          <strong>OpenAI API</strong>
          <p>An OpenAI API Platform key is required. ChatGPT subscriptions and API billing are separate.</p>
          <div class="api-links">
            <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">Create / manage API key</a>
            <a href="https://platform.openai.com/settings/organization/billing/overview" target="_blank" rel="noreferrer">API billing</a>
          </div>
        </div>

        <label>OpenAI API key
          <div class="secret-row">
            <input v-model="settings.openaiApiKey" :type="showApiKey ? 'text' : 'password'" autocomplete="off" placeholder="sk-…" />
            <button class="secret-toggle" type="button" @click="showApiKey = !showApiKey">{{ showApiKey ? 'Hide' : 'Show' }}</button>
          </div>
        </label>

        <label>OpenAI model
          <select v-model="settings.openaiModel">
            <option value="gpt-5.6-luna">GPT-5.6 Luna — lowest cost, recommended</option>
            <option value="gpt-5.6-terra">GPT-5.6 Terra</option>
            <option value="gpt-5.6-sol">GPT-5.6 Sol</option>
          </select>
        </label>
      </div>

      <div v-if="settings.provider === 'deepl'" class="api-section">
        <div class="api-help"><strong>DeepL API</strong><p>Paste a DeepL API Free or Pro authentication key.</p></div>
        <label>DeepL API key
          <div class="secret-row">
            <input v-model="settings.deeplApiKey" :type="showApiKey ? 'text' : 'password'" autocomplete="off" />
            <button class="secret-toggle" type="button" @click="showApiKey = !showApiKey">{{ showApiKey ? 'Hide' : 'Show' }}</button>
          </div>
        </label>
      </div>

      <div v-if="settings.provider === 'google'" class="api-section">
        <div class="api-help"><strong>Google Cloud Translation</strong><p>Requires a Google Cloud project with Cloud Translation API enabled.</p></div>
        <label>Google Cloud API key
          <div class="secret-row">
            <input v-model="settings.googleApiKey" :type="showApiKey ? 'text' : 'password'" autocomplete="off" />
            <button class="secret-toggle" type="button" @click="showApiKey = !showApiKey">{{ showApiKey ? 'Hide' : 'Show' }}</button>
          </div>
        </label>
      </div>

      <div class="api-test-card">
        <div class="api-test-head">
          <div><strong>API connection test</strong><small>Uses the values currently entered above. You do not need to save first.</small></div>
          <span class="api-badge" :class="apiState">{{ apiState === 'success' ? 'Connected' : apiState === 'error' ? 'Needs attention' : 'Not tested' }}</span>
        </div>
        <textarea v-model="testText" placeholder="Test text"></textarea>
        <button class="secondary" :disabled="testing" @click="testApi">{{ testing ? 'Testing…' : 'Test API + Translation' }}</button>
        <p v-if="apiMessage" class="api-message" :class="apiState">{{ apiMessage }}</p>
        <pre v-if="testResult" class="api-result">{{ testResult }}</pre>
      </div>

      <div class="toggles">
        <label><input v-model="settings.receiveAutoTranslate" type="checkbox" /> Automatically translate received messages</label>
        <label><input v-model="settings.sendAutoTranslate" type="checkbox" /> Translate before sending</label>
      </div>

      <footer>
        <button class="secondary" @click="emit('close')">Cancel</button>
        <button class="primary" :disabled="saving" @click="save">{{ saving ? 'Saving…' : 'Save' }}</button>
      </footer>
    </section>
  </div>
</template>
