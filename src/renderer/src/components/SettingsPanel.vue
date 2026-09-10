<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { requireSupabase } from '../lib/supabase'

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
const checking = ref(false)
const routeResults = ref<any[]>([])
const diagnoses = ref<any[]>([])
const connectionError = ref('')
async function checkConnection() {
  if (checking.value) return
  checking.value = true; connectionError.value = ''
  try {
    await syncCloudSession()
    const [routes, checks] = await Promise.all([window.desktopAPI.measureRoutes(), window.desktopAPI.diagnoseConnection()])
    routeResults.value = routes; diagnoses.value = checks
  } catch (error: any) { connectionError.value = error?.message || '连接检查失败，请重试。' }
  finally { checking.value = false }
}
async function selectRoute() {
  try { await window.desktopAPI.saveCloudRoute(settings.value.cloudRoute); await checkConnection() }
  catch (error: any) { connectionError.value = error?.message || '线路保存失败。' }
}
function diagnosisLabel(item: any) {
  if (!item.ok) return item.message
  if (item.id === 'account') return item.data?.active ? `账号可用 · 余额 ${Number(item.data.balance || 0).toLocaleString()} 字符` : '账号已停用，请联系管理员。'
  const code = item.data?.code
  const messages: Record<string, string> = {
    provider_auth: '服务端凭据无效，需要管理员更新。',
    provider_quota: '翻译服务额度不足，需要管理员处理。',
    provider_model: '当前模型不可用，需要管理员检查模型权限。',
    provider_permission: '无法确认模型权限，请进行一次翻译测试。',
    provider_request: '翻译服务配置需要管理员检查。'
  }
  return messages[code] || (item.data?.status === 'available' ? '模型可访问，实际翻译待测试。' : '暂时无法确认模型状态，请重试或测试翻译。')
}
function needsAttention(item: any) { return !item.ok || (item.id === 'account' ? !item.data?.active : item.data?.status === 'attention') }


const configuredKey = computed(() => {
  if (!settings.value) return ''
  if (settings.value.provider === 'openai') return 'cloud-managed'
  if (settings.value.provider === 'deepl') return String(settings.value.deeplApiKey || '').trim()
  return String(settings.value.googleApiKey || '').trim()
})

const providerLabel = computed(() => {
  if (!settings.value) return ''
  if (settings.value.provider === 'openai') return 'HelloDog 云端翻译'
  if (settings.value.provider === 'deepl') return 'DeepL'
  return 'Google Cloud Translation'
})

function languageLabel(language: any): string {
  return language?.zhName || language?.name || language?.code || ''
}

function settingsSnapshot(): any {
  const snapshot = JSON.parse(JSON.stringify(settings.value || {}))
  if (typeof snapshot.deeplApiKey === 'string') snapshot.deeplApiKey = snapshot.deeplApiKey.trim()
  if (typeof snapshot.googleApiKey === 'string') snapshot.googleApiKey = snapshot.googleApiKey.trim()
  snapshot.blockChineseSend = snapshot.blockChineseSend !== false
  snapshot.openaiModel = 'gpt-5.6-luna'
  snapshot.openaiApiKey = ''
  return snapshot
}

async function syncCloudSession() {
  const client = requireSupabase()
  const { data, error } = await client.auth.getSession()
  if (error) throw error
  const session = data.session
  if (!session?.user?.id || !session.access_token) throw new Error('在线登录状态已失效，请重新登录。')
  await window.desktopAPI.authSetOnlineSession({
    userId: session.user.id,
    email: session.user.email,
    username: String(session.user.user_metadata?.username || ''),
    accessToken: session.access_token
  })
}

onMounted(async () => {
  settings.value = await window.desktopAPI.getSettings()
  if (settings.value.blockChineseSend === undefined) settings.value.blockChineseSend = true
  settings.value.openaiModel = 'gpt-5.6-luna'
  settings.value.openaiApiKey = ''
  settings.value.cloudRoute ||= 'auto'
  languages.value = await window.desktopAPI.getLanguages()
  void checkConnection()
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
  apiMessage.value = settings.value.provider === 'openai' ? '正在验证登录并测试翻译，请稍候…' : '正在测试 API 连接和翻译…'
  testResult.value = ''
  try {
    if (settings.value.provider === 'openai') await syncCloudSession()
    const current = settingsSnapshot()
    const result = await window.desktopAPI.testTranslationConfig(current, testText.value, current.localLanguage)
    if (result.ok) {
      apiState.value = 'success'
      apiMessage.value = settings.value.provider === 'openai' ? '云端翻译连接成功。' : 'API 连接和翻译测试成功。'
      testResult.value = result.translated || ''
    } else {
      apiState.value = 'error'
      apiMessage.value = result.message || '连接失败。'
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

      <div class="connection-detail">
        <h3>连接诊断</h3>
        <div class="route-picker"><select v-model="settings.cloudRoute" aria-label="翻译线路" @change="selectRoute"><option value="auto">自动切换线路</option><option value="primary">主线路 · api.hellodog.net</option><option value="backup">备用线路 · workers.dev</option></select><button class="secondary" :disabled="checking" @click="checkConnection">{{ checking ? '检测中…' : '重新检测' }}</button></div>
        <p class="diagnosis-note">线路选择立即保存。连接检测不发起翻译，不消耗字符。</p>
        <div class="diagnosis-grid"><div v-for="route in routeResults" :key="route.id" class="diagnosis-row" :class="{ attention: !route.available }"><b>{{ route.label }}</b><span>{{ route.available ? `可访问 · ${route.latencyMs} ms` : '当前网络无法访问' }}</span></div><div v-for="item in diagnoses" :key="item.id" class="diagnosis-row" :class="{ attention: needsAttention(item) }"><b>{{ item.id === 'account' ? '登录与字符余额' : '翻译服务' }}</b><span>{{ diagnosisLabel(item) }}</span></div></div>
        <p v-if="connectionError" class="api-message error" role="alert">{{ connectionError }}</p>
        <p v-if="routeResults.length" class="diagnosis-note">以上是本次检测结果。线路延迟不包含翻译耗时；模型可访问不代表翻译已成功。</p>
      </div>

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
          <option value="openai">HelloDog 云端</option>
          <option value="deepl">DeepL</option>
          <option value="google">Google Cloud Translation</option>
        </select>
      </label>

      <div v-if="settings.provider === 'openai'" class="api-section">
        <div class="api-help">
          <strong>HelloDog 云端翻译</strong>
          <p>登录 HelloDog 账号即可使用。翻译成功后按字符扣费，失败不扣费。</p>

        </div>
      </div>

      <div v-if="settings.provider === 'deepl'" class="api-section">
        <div class="api-help"><strong>DeepL API</strong><p>填写 DeepL API Free 或 Pro 的认证 Key。</p></div>
        <label>DeepL API Key
          <div class="secret-row"><input v-model="settings.deeplApiKey" :type="showApiKey ? 'text' : 'password'" autocomplete="off" /><button class="secret-toggle" type="button" @click="showApiKey = !showApiKey">{{ showApiKey ? '隐藏' : '显示' }}</button></div>
        </label>
      </div>

      <div v-if="settings.provider === 'google'" class="api-section">
        <div class="api-help"><strong>Google Cloud Translation</strong><p>需要已启用 Cloud Translation API 的 Google Cloud 项目。</p></div>
        <label>Google Cloud API Key
          <div class="secret-row"><input v-model="settings.googleApiKey" :type="showApiKey ? 'text' : 'password'" autocomplete="off" /><button class="secret-toggle" type="button" @click="showApiKey = !showApiKey">{{ showApiKey ? '隐藏' : '显示' }}</button></div>
        </label>
      </div>

      <div class="api-test-card">
        <div class="api-test-head"><div><strong>{{ settings.provider === 'openai' ? '云端连接测试' : 'API 连接测试' }}</strong><small>{{ settings.provider === 'openai' ? '发起一次真实翻译。成功按字符计费，失败不扣费。' : '直接使用上面当前填写的内容测试，不需要先保存。' }}</small></div><span class="api-badge" :class="apiState">{{ apiState === 'success' ? '已连接' : apiState === 'error' ? '需要处理' : '未测试' }}</span></div>
        <textarea v-model="testText" placeholder="输入测试文本"></textarea>
        <button class="secondary" :disabled="testing || checking || !testText.trim()" @click="testApi">{{ testing ? '测试中…' : '测试翻译' }}</button>
        <p v-if="apiMessage" class="api-message" :class="apiState">{{ apiMessage }}</p>
        <pre v-if="testResult" class="api-result">{{ testResult }}</pre>
      </div>

      <div class="toggles">
        <label><input v-model="settings.receiveAutoTranslate" type="checkbox" /> 自动翻译收到的消息</label>
        <label><input v-model="settings.sendAutoTranslate" type="checkbox" /> 发送前自动翻译</label>
        <label class="important-toggle"><input v-model="settings.blockChineseSend" type="checkbox" /> 禁止发送中文 <small>开启后，如果翻译失败或输入框仍含中文，将直接阻止发送，避免中文原文误发。</small></label>
      </div>

      <footer><button class="secondary" @click="emit('close')">取消</button><button class="primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存设置' }}</button></footer>
    </section>
  </div>
</template>
