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

function languageLabel(language: any): string {
  return language?.zhName || language?.name || language?.code || ''
}

function settingsSnapshot(): any {
  const snapshot = JSON.parse(JSON.stringify(settings.value || {}))
  if (typeof snapshot.openaiApiKey === 'string') snapshot.openaiApiKey = snapshot.openaiApiKey.trim()
  if (typeof snapshot.deeplApiKey === 'string') snapshot.deeplApiKey = snapshot.deeplApiKey.trim()
  if (typeof snapshot.googleApiKey === 'string') snapshot.googleApiKey = snapshot.googleApiKey.trim()
  snapshot.blockChineseSend = snapshot.blockChineseSend !== false
  return snapshot
}

onMounted(async () => {
  settings.value = await window.desktopAPI.getSettings()
  if (settings.value.blockChineseSend === undefined) settings.value.blockChineseSend = true
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
    apiMessage.value = `请先填写 ${providerLabel.value} API Key。`
    testResult.value = ''
    return
  }

  testing.value = true
  apiState.value = 'idle'
  apiMessage.value = '正在测试 API 连接和翻译…'
  testResult.value = ''
  try {
    const current = settingsSnapshot()
    const result = await window.desktopAPI.testTranslationConfig(current, testText.value, current.localLanguage)
    if (result.ok) {
      apiState.value = 'success'
      apiMessage.value = 'API 连接和翻译测试成功。'
      testResult.value = result.translated || ''
    } else {
      apiState.value = 'error'
      apiMessage.value = result.message || 'API 连接失败。'
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
    apiMessage.value = `自动翻译已开启，请先填写 ${providerLabel.value} API Key。`
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
      <header><h2>翻译设置</h2><button title="关闭" @click="emit('close')">×</button></header>

      <div class="mode-lock"><span>翻译模式</span><strong>精准翻译</strong><small>固定</small></div>

      <label>我的语言
        <select v-model="settings.localLanguage">
          <option v-for="language in languages.filter(x => x.code !== 'auto')" :key="language.code" :value="language.code">{{ languageLabel(language) }}</option>
        </select>
      </label>

      <label>对方语言
        <select v-model="settings.targetLanguage">
          <option v-for="language in languages.filter(x => x.code !== 'auto')" :key="language.code" :value="language.code">{{ languageLabel(language) }}</option>
        </select>
      </label>

      <label>翻译引擎
        <select v-model="settings.provider">
          <option value="openai">OpenAI</option>
          <option value="deepl">DeepL</option>
          <option value="google">Google Cloud Translation</option>
        </select>
      </label>

      <div v-if="settings.provider === 'openai'" class="api-section">
        <div class="api-help">
          <strong>OpenAI API</strong>
          <p>需要 OpenAI API Platform 的 API Key。ChatGPT 订阅与 API 计费彼此独立。</p>
          <div class="api-links">
            <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">创建 / 管理 API Key</a>
            <a href="https://platform.openai.com/settings/organization/billing/overview" target="_blank" rel="noreferrer">API 余额与计费</a>
          </div>
        </div>

        <label>OpenAI API Key
          <div class="secret-row">
            <input v-model="settings.openaiApiKey" :type="showApiKey ? 'text' : 'password'" autocomplete="off" placeholder="sk-…" />
            <button class="secret-toggle" type="button" @click="showApiKey = !showApiKey">{{ showApiKey ? '隐藏' : '显示' }}</button>
          </div>
        </label>

        <label>OpenAI 模型
          <select v-model="settings.openaiModel">
            <option value="gpt-5.6-luna">GPT-5.6 Luna — 低成本，推荐</option>
            <option value="gpt-5.6-terra">GPT-5.6 Terra</option>
            <option value="gpt-5.6-sol">GPT-5.6 Sol</option>
          </select>
        </label>
      </div>

      <div v-if="settings.provider === 'deepl'" class="api-section">
        <div class="api-help"><strong>DeepL API</strong><p>填写 DeepL API Free 或 Pro 的认证 Key。</p></div>
        <label>DeepL API Key
          <div class="secret-row">
            <input v-model="settings.deeplApiKey" :type="showApiKey ? 'text' : 'password'" autocomplete="off" />
            <button class="secret-toggle" type="button" @click="showApiKey = !showApiKey">{{ showApiKey ? '隐藏' : '显示' }}</button>
          </div>
        </label>
      </div>

      <div v-if="settings.provider === 'google'" class="api-section">
        <div class="api-help"><strong>Google Cloud Translation</strong><p>需要已启用 Cloud Translation API 的 Google Cloud 项目。</p></div>
        <label>Google Cloud API Key
          <div class="secret-row">
            <input v-model="settings.googleApiKey" :type="showApiKey ? 'text' : 'password'" autocomplete="off" />
            <button class="secret-toggle" type="button" @click="showApiKey = !showApiKey">{{ showApiKey ? '隐藏' : '显示' }}</button>
          </div>
        </label>
      </div>

      <div class="api-test-card">
        <div class="api-test-head">
          <div><strong>API 连接测试</strong><small>直接使用上面当前填写的内容测试，不需要先保存。</small></div>
          <span class="api-badge" :class="apiState">{{ apiState === 'success' ? '已连接' : apiState === 'error' ? '需要处理' : '未测试' }}</span>
        </div>
        <textarea v-model="testText" placeholder="输入测试文本"></textarea>
        <button class="secondary" :disabled="testing" @click="testApi">{{ testing ? '测试中…' : '测试 API + 翻译' }}</button>
        <p v-if="apiMessage" class="api-message" :class="apiState">{{ apiMessage }}</p>
        <pre v-if="testResult" class="api-result">{{ testResult }}</pre>
      </div>

      <div class="toggles">
        <label><input v-model="settings.receiveAutoTranslate" type="checkbox" /> 自动翻译收到的消息</label>
        <label><input v-model="settings.sendAutoTranslate" type="checkbox" /> 发送前自动翻译</label>
        <label class="important-toggle"><input v-model="settings.blockChineseSend" type="checkbox" /> 禁止发送中文 <small>开启后，如果翻译失败或输入框仍含中文，将直接阻止发送，避免中文原文误发。</small></label>
      </div>

      <footer>
        <button class="secondary" @click="emit('close')">取消</button>
        <button class="primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存设置' }}</button>
      </footer>
    </section>
  </div>
</template>
