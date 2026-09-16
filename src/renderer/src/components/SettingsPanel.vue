<script setup lang="ts">
import { t, uiLanguage, languageName, uiError } from '../lib/uiLocale'
import { uiPreference } from '../lib/uiLocale'
import UiLanguagePicker from './UiLanguagePicker.vue'

import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { prepareBeforeRestart } from '../lib/restartState'
import { requireSupabase } from '../lib/supabase'

const emit = defineEmits(['close','updated'])
const settings = ref<any>(null)
const savedSnapshot = ref<any>(null), undoSnapshot = ref<any>(null), glossaryText = ref(''), repliesText = ref('')
let writes: Promise<any> = Promise.resolve()
onUnmounted(prepareBeforeRestart(() => writes))
async function restoreBackup() { try { if (await window.desktopAPI.restoreSettingsBackup()) { settings.value = await window.desktopAPI.getSettings(); settings.value.translationQuality ||= {}; savedSnapshot.value = JSON.parse(JSON.stringify(settings.value)); syncText(); emit('updated'); apiMessage.value = t('设置备份已恢复。') } } catch (e:any) { apiMessage.value = e.message } }
async function exportBackup() { try { if (await window.desktopAPI.exportSettingsBackup()) apiMessage.value = t('设置备份已导出，不含密钥或聊天内容。') } catch (e:any) { apiMessage.value = e.message } }
function syncText() { glossaryText.value = (settings.value.translationQuality?.glossary || []).map((item:any) => item.source + ' = ' + item.target).join('\n'); repliesText.value = (settings.value.quickReplies || []).join('\n') }
const tab = ref('translation')
const sections = computed(() => ([{id:'translation',label:t('翻译')},{id:'connection',label:t('连接')},{id:'notifications',label:t('通知')},{id:'appearance',label:t('外观')},{id:'runtime',label:t('运行')},{id:'data',label:t('数据')}]))
const cacheInfo = ref<any>(null), confirmClear = ref(false), clearing = ref(false)
const sidebarSmall = ref(localStorage.getItem('hellodog:sidebar-collapsed') === 'true')
async function refreshCache() { try { cacheInfo.value = await window.desktopAPI.getCacheInfo() } catch (e: any) { apiMessage.value = e.message } }
async function clearCache() { clearing.value = true; try { await window.desktopAPI.clearTranslationCache(); confirmClear.value = false; await refreshCache() } catch (e: any) { apiMessage.value = e.message } finally { clearing.value = false } }
watch(tab, value => { if (value === 'data') void refreshCache() })

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
  } catch (error: any) { connectionError.value = error?.message || t('连接检查失败，请重试。') }
  finally { checking.value = false }
}
async function selectRoute() {
  try { await checkConnection() }
  catch (error: any) { connectionError.value = error?.message || t('线路保存失败。') }
}
function diagnosisLabel(item: any) {
  if (!item.ok) return item.message
  if (item.id === 'account') return item.data?.active ? t('账号可用 · 余额 {0} 字符', Number(item.data.balance || 0).toLocaleString()) : t('账号已停用，请联系管理员。')
  const code = item.data?.code
  const messages: Record<string, string> = {
    provider_auth: t('服务端凭据无效，需要管理员更新。'),
    provider_quota: t('翻译服务额度不足，需要管理员处理。'),
    provider_model: t('当前模型不可用，需要管理员检查模型权限。'),
    provider_permission: t('无法确认模型权限，请进行一次翻译测试。'),
    provider_request: t('翻译服务配置需要管理员检查。')
  }
  return messages[code] || (item.data?.status === 'available' ? t('模型可访问，实际翻译待测试。') : t('暂时无法确认模型状态，请重试或测试翻译。'))
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
  if (settings.value.provider === 'openai') return t('HelloDog 云端翻译')
  if (settings.value.provider === 'deepl') return 'DeepL'
  return 'Google Cloud Translation'
})

function languageLabel(language: any): string {
  return languageName(language || {})
}

function settingsSnapshot(): any {
  const snapshot = JSON.parse(JSON.stringify(settings.value || {}))
  snapshot.uiLanguage = uiPreference.value
  if (typeof snapshot.deeplApiKey === 'string') snapshot.deeplApiKey = snapshot.deeplApiKey.trim()
  if (typeof snapshot.googleApiKey === 'string') snapshot.googleApiKey = snapshot.googleApiKey.trim()
  snapshot.blockChineseSend = snapshot.blockChineseSend !== false
  const glossary = glossaryText.value.split(/\r?\n/).filter(line => line.trim()).map(line => { const i = line.indexOf('='); if (i < 1 || !line.slice(i+1).trim()) throw new Error(t('术语请按“原文 = 译文”填写。')); return {source:line.slice(0,i).trim(),target:line.slice(i+1).trim()} });
  snapshot.translationQuality = { ...snapshot.translationQuality, glossary };
  snapshot.quickReplies = repliesText.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  snapshot.openaiModel = ''
  snapshot.openaiApiKey = ''
  return snapshot
}

async function syncCloudSession() {
  const client = requireSupabase()
  const { data, error } = await client.auth.getSession()
  if (error) throw error
  const session = data.session
  if (!session?.user?.id || !session.access_token) throw new Error(t('在线登录状态已失效，请重新登录。'))
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
  settings.value.openaiModel = ''
  settings.value.openaiApiKey = ''
  settings.value.cloudRoute ||= 'auto'
  settings.value.translationQuality ||= {}
  savedSnapshot.value = JSON.parse(JSON.stringify(settings.value))
  syncText()
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
    apiMessage.value = t('请先填写 {0} API Key。', providerLabel.value)
    testResult.value = ''
    return
  }

  testing.value = true
  apiState.value = 'idle'
  apiMessage.value = settings.value.provider === 'openai' ? t('正在验证登录并测试翻译，请稍候…') : t('正在测试 API 连接和翻译…')
  testResult.value = ''
  try {
    if (settings.value.provider === 'openai') await syncCloudSession()
    const current = settingsSnapshot()
    const result = await window.desktopAPI.testTranslationConfig(current, testText.value, current.localLanguage)
    if (result.ok) {
      apiState.value = 'success'
      apiMessage.value = settings.value.provider === 'openai' ? t('云端翻译连接成功。') : t('API 连接和翻译测试成功。')
      testResult.value = result.translated || ''
    } else {
      apiState.value = 'error'
      apiMessage.value = result.message || t('连接失败。')
    }
  } catch (error: any) {
    apiState.value = 'error'
    apiMessage.value = error.message || String(error)
  } finally {
    testing.value = false
  }
}

async function save(close = true) {
  if ((settings.value.receiveAutoTranslate || settings.value.sendAutoTranslate) && !configuredKey.value) {
    apiState.value = 'error'
    apiMessage.value = t('自动翻译已开启，请先填写 {0} API Key。', providerLabel.value)
    return
  }

  saving.value = true
  try {
    const current = settingsSnapshot()
    writes = writes.catch(() => undefined).then(async () => { const previous = savedSnapshot.value; await window.desktopAPI.saveSettings(current); undoSnapshot.value = previous; savedSnapshot.value = JSON.parse(JSON.stringify(current)); });
    await writes
    emit('updated')
    localStorage.setItem('hellodog:sidebar-collapsed', String(sidebarSmall.value))
    apiMessage.value = t('已立即应用。账号单独设置保持优先，通知和运行设置作用于整个应用。')
    if (close) emit('close')
  } catch (error: any) {
    apiState.value = 'error'
    apiMessage.value = error.message || String(error)
  } finally {
    saving.value = false
  }
}
async function undo() {
  if (!undoSnapshot.value || saving.value) return;
  try { await window.desktopAPI.saveSettings(JSON.parse(JSON.stringify(undoSnapshot.value))); settings.value = JSON.parse(JSON.stringify(undoSnapshot.value)); settings.value.translationQuality ||= {}; savedSnapshot.value = JSON.parse(JSON.stringify(undoSnapshot.value)); undoSnapshot.value = null; syncText(); emit('updated'); apiMessage.value = t('已撤销上次修改。') } catch (e:any) { apiMessage.value = e.message }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section v-if="settings" class="panel settings-panel" role="dialog" aria-modal="true" :aria-label="t('全局设置')">
      <header><h2>{{ t('全局设置') }}</h2><button :title="t('关闭')" @click="emit('close')">×</button></header>

      <nav class="settings-tabs" :aria-label="t('设置分类')"><button v-for="section in sections" :key="section.id" :aria-pressed="tab === section.id" @click="tab = section.id">{{ section.label }}</button></nav>
      <div class="settings-scroll" @change="save(false)" tabindex="0" :aria-label="t('设置内容，可滚动')">
      <div v-show="tab === 'connection'" class="connection-detail">
        <h3>{{ t('连接诊断') }}</h3>
        <div class="route-picker"><select v-model="settings.cloudRoute" :aria-label="t('翻译线路')" @change="selectRoute"><option value="auto">{{ t('自动切换线路') }}</option><option value="primary">{{ t('主线路 · api.hellodog.net') }}</option><option value="backup">{{ t('备用线路 · workers.dev') }}</option></select><button class="secondary" :disabled="checking" @click="checkConnection">{{ checking ? t('检测中…') : t('重新检测') }}</button></div>
        <p class="diagnosis-note">{{ t('线路选择立即保存。连接检测不发起翻译，不消耗字符。') }}</p>
        <div class="diagnosis-grid"><div v-for="route in routeResults" :key="route.id" class="diagnosis-row" :class="{ attention: !route.available }"><b>{{ route.label }}</b><span>{{ route.available ? t('可访问 · {0} ms', route.latencyMs) : t('当前网络无法访问') }}</span></div><div v-for="item in diagnoses" :key="item.id" class="diagnosis-row" :class="{ attention: needsAttention(item) }"><b>{{ item.id === 'account' ? t('登录与字符余额') : t('翻译服务') }}</b><span>{{ diagnosisLabel(item) }}</span></div></div>
        <p v-if="connectionError" class="api-message error" role="alert">{{ uiError(connectionError) }}</p>
        <p v-if="routeResults.length" class="diagnosis-note">{{ t('以上是本次检测结果。线路延迟不包含翻译耗时；模型可访问不代表翻译已成功。') }}</p>
      </div>

      <div v-show="tab === 'translation'">
      <p>{{ t('修改后立即应用。已有账号和联系人的单独设置优先；通知、连接与运行设置影响整个应用。') }}</p>
      <label>{{ t('默认语气') }}<select v-model="settings.translationQuality.tone"><option :value="undefined">{{ t('跟随原文') }}</option><option value="natural">{{ t('自然') }}</option><option value="business">{{ t('商务') }}</option></select></label>
      <label>{{ t('术语表，每行：原文 = 译文') }}<textarea v-model="glossaryText" rows="3" placeholder="HelloDog = HelloDog" /></label><p>{{ t('网址、邮箱与号码原样保留。修改术语或语气影响新翻译，已显示的历史不会自动重新扣费。') }}</p>
      <label>{{ t('快捷回复，每行一条') }}<textarea v-model="repliesText" rows="3" :placeholder="t('保存常用回复，再从快捷操作填入聊天框')" /></label>
      <label>{{ t('我的语言 ') }}<select v-model="settings.localLanguage">
          <option v-for="language in languages.filter(x => x.code !== 'auto')" :key="language.code" :value="language.code">{{ languageLabel(language) }}</option>
        </select>
      </label>

      <label>{{ t('对方语言 ') }}<select v-model="settings.targetLanguage">
          <option v-for="language in languages.filter(x => x.code !== 'auto')" :key="language.code" :value="language.code">{{ languageLabel(language) }}</option>
        </select>
      </label>

      <label>{{ t('翻译引擎 ') }}<select v-model="settings.provider">
          <option value="openai">{{ t('HelloDog 云端') }}</option>
          <option value="deepl">DeepL</option>
          <option value="google">Google Cloud Translation</option>
        </select>
      </label>

      <div v-if="settings.provider === 'openai'" class="api-section">
        <div class="api-help">
          <strong>{{ t('HelloDog 云端翻译') }}</strong>
          <p>{{ t('登录 HelloDog 账号即可使用。翻译成功后按字符扣费，失败不扣费。') }}</p>

        </div>
      </div>

      <div v-if="settings.provider === 'deepl'" class="api-section">
        <div class="api-help"><strong>DeepL API</strong><p>{{ t('填写 DeepL API Free 或 Pro 的认证 Key。') }}</p></div>
        <label>DeepL API Key
          <div class="secret-row"><input v-model="settings.deeplApiKey" :type="showApiKey ? 'text' : 'password'" autocomplete="off" /><button class="secret-toggle" type="button" @click="showApiKey = !showApiKey">{{ showApiKey ? t('隐藏') : t('显示') }}</button></div>
        </label>
      </div>

      <div v-if="settings.provider === 'google'" class="api-section">
        <div class="api-help"><strong>Google Cloud Translation</strong><p>{{ t('需要已启用 Cloud Translation API 的 Google Cloud 项目。') }}</p></div>
        <label>Google Cloud API Key
          <div class="secret-row"><input v-model="settings.googleApiKey" :type="showApiKey ? 'text' : 'password'" autocomplete="off" /><button class="secret-toggle" type="button" @click="showApiKey = !showApiKey">{{ showApiKey ? t('隐藏') : t('显示') }}</button></div>
        </label>
      </div>

      </div>
      <div v-show="tab === 'connection'" class="api-test-card">
        <div class="api-test-head"><div><strong>{{ settings.provider === 'openai' ? t('云端连接测试') : t('API 连接测试') }}</strong><small>{{ settings.provider === 'openai' ? t('发起一次真实翻译。成功按字符计费，失败不扣费。') : t('直接使用上面当前填写的内容测试，不需要先保存。') }}</small></div><span class="api-badge" :class="apiState">{{ apiState === 'success' ? t('已连接') : apiState === 'error' ? t('需要处理') : t('未测试') }}</span></div>
        <textarea v-model="testText" :placeholder="t('输入测试文本')"></textarea>
        <button class="secondary" :disabled="testing || checking || !testText.trim()" @click="testApi">{{ testing ? t('测试中…') : t('测试翻译') }}</button>
        <p v-if="apiMessage" class="api-message" :class="apiState">{{ uiError(apiMessage) }}</p>
        <pre v-if="testResult" class="api-result">{{ testResult }}</pre>
      </div>

      <div v-show="tab === 'translation'" class="toggles">
        <label><input v-model="settings.receiveAutoTranslate" type="checkbox" />{{ t(' 自动翻译收到的消息') }}</label>
        <label><input v-model="settings.sendAutoTranslate" type="checkbox" />{{ t(' 发送前自动翻译') }}</label>
        <label class="important-toggle"><input type="checkbox" checked disabled />{{ t(' 禁止发送中文 ') }}<small>{{ t('强制保护：外语消息仍含中文时禁止发送。翻译失败、登录未恢复或没有可用字符时保留草稿。') }}</small></label>
      </div>

      <section v-show="tab === 'translation'" class="settings-group"><h3>{{ t('历史与发送体验') }}</h3>
        <label>{{ t('历史消息') }}<select v-model="settings.historyMode"><option value="new">{{ t('仅新消息自动翻译，历史先读缓存') }}</option><option value="manual">{{ t('全部手动翻译，已有译文照常显示') }}</option><option value="visible">{{ t('自动翻译当前可见历史（可能计费）') }}</option></select></label>
        <label class="setup-toggle"><span>{{ t('发送前展开译文预览（双输入框）') }}</span><input v-model="settings.previewSend" type="checkbox" /></label>
        <label class="setup-toggle"><span>{{ t('在预览中提供回翻按钮') }}</span><input v-model="settings.backTranslation" type="checkbox" /></label><p>{{ t('回翻由你主动点击，成功翻译可能产生额外字符费用。默认直接翻译发送，不强制弹窗。') }}</p>
      </section>
      <section v-show="tab === 'notifications'" class="settings-group"><h3>{{ t('新消息提醒') }}</h3><label>{{ t('系统通知') }}<select v-model="settings.notifications"><option value="off">{{ t('关闭') }}</option><option value="background">{{ t('仅后台通知') }}</option><option value="always">{{ t('始终通知') }}</option></select></label><label class="setup-toggle"><span>{{ t('通知声音') }}</span><input v-model="settings.notificationSound" type="checkbox" /></label><label class="setup-toggle"><span>{{ t('隐藏通知中的账号和联系人名称') }}</span><input v-model="settings.hideNotificationNames" type="checkbox" /></label><p>{{ t('通知不展示聊天正文；开启隐藏名称后，只显示有新消息。') }}</p></section>
      <section v-show="tab === 'appearance'" class="settings-group"><UiLanguagePicker /><label>{{ t('深色主题') }}<select :value="settings.workspaceTheme || 'charcoal'" @change="settings.workspaceTheme = ($event.target as HTMLSelectElement).value; save(false)"><option value="charcoal">{{ t('墨黑') }}</option><option value="soft">{{ t('柔和深灰') }}</option></select></label><h3>{{ t('布局') }}</h3><label>{{ t('账号切换栏位置') }}<select v-model="settings.accountNavigationPosition" @change="save(false)"><option value="top">{{ t('顶部') }}</option><option value="side">{{ t('侧边') }}</option></select></label><label class="setup-toggle"><span>{{ t('隐藏功能栏') }}</span><input v-model="sidebarSmall" type="checkbox" /></label><p>{{ t('左侧每种应用只显示一个入口。账号用数字区分，悬停查看名称；红色角标表示未读。位置修改立即生效，可撤销。') }}</p></section>
      <section v-show="tab === 'runtime'" class="settings-group"><h3>{{ t('桌面运行') }}</h3><label class="setup-toggle"><span>{{ t('开机启动（Windows / macOS）') }}</span><input v-model="settings.autoStart" type="checkbox" /></label><label class="setup-toggle"><span>{{ t('启动后最小化') }}</span><input v-model="settings.startMinimized" type="checkbox" /></label><label class="setup-toggle"><span>{{ t('点击右上角 X 后在后台运行（推荐）') }}</span><input v-model="settings.closeToTray" type="checkbox" /></label><p>{{ t('默认关闭窗口不退出、不停止后台翻译；通过系统托盘菜单“退出 HelloDog”完全退出。关闭此选项后，X 将退出窗口。启动最小化将在下次启动生效。') }}</p></section>
      <section v-show="tab === 'data'" class="settings-group"><h3>{{ t('翻译缓存') }}</h3><p>{{ cacheInfo ? t('当前账号缓存：') + cacheInfo.translations + t(' 条，约 ') + (cacheInfo.bytes / 1024).toFixed(1) + t(' KB；缓存文件合计 ') + (cacheInfo.totalBytes / 1024).toFixed(1) + ' KB' : t('读取中…') }}</p><button class="secondary" @click="refreshCache">{{ t('刷新统计') }}</button><button class="secondary" @click="confirmClear = true">{{ t('清理我的翻译缓存…') }}</button><div v-if="confirmClear" role="alert"><p>{{ t('仅清理当前账号的译文缓存。保留登录、代理、草稿和请求防重记录。确定清理？') }}</p><button :disabled="clearing" class="secondary" @click="clearCache">{{ t('确认清理') }}</button><button class="secondary" @click="confirmClear = false">{{ t('取消') }}</button></div><h3>{{ t('设置备份与恢复') }}</h3><p>{{ t('备份语言、术语、快捷回复和应用偏好。不含密钥、登录、账号会话、聊天内容或发送任务。请求防重记录和草稿仍保存在本机，不随清缓存删除。') }}</p><button class="secondary" @click="exportBackup">{{ t('导出设置备份') }}</button><button class="secondary" @click="restoreBackup">{{ t('选择备份并预览恢复…') }}</button></section>
      <p v-if="apiMessage && tab !== 'connection'" role="status">{{ uiError(apiMessage) }}</p>
      </div>
      <footer><button class="secondary" :disabled="!undoSnapshot || saving" @click="undo">{{ t('撤销上次修改') }}</button><button class="secondary" @click="emit('close')">{{ t('关闭') }}</button><button class="primary" :disabled="saving" @click="save(true)">{{ saving ? t('保存中…') : t('保存设置') }}</button></footer>
    </section>
  </div>
</template>
