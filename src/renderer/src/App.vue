<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import UiIcon from './components/UiIcon.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import PersonalCenter from './components/PersonalCenter.vue'
import SignalView from './components/SignalView.vue'
import { cloudApi } from './lib/cloudApi'
import { RemoteSnapshot } from './lib/remoteSnapshot'

const props = defineProps<{ userId: string }>()

type ContactPreference = { language: string; name?: string; updatedAt: number; source?: 'manual'|'auto' }
type Account = {
  id: string
  platform: 'whatsapp'|'signal'
  label: string
  signalAccount?: string
  localLanguage?: string
  targetLanguage?: string
  receiveAutoTranslate?: boolean
  sendAutoTranslate?: boolean
  blockChineseSend?: boolean
  groupTranslate?: boolean
  fontSize?: number
  translationsVisible?: boolean
  zoomFactor?: number
  translationColor?: string
  contactLanguages?: Record<string, ContactPreference>
}

type LiveStatus = { state: 'ready'|'working'|'success'|'error'; message: string; at?: number }
type ConversationInfo = { id: string; name?: string }

const accounts = ref<Account[]>([])
const selected = ref<Account | null>(null)
const showSettings = ref(false)
const showProfile = ref(false)
const error = ref('')
const collapsed = ref(localStorage.getItem('hellodog:sidebar-collapsed') === 'true')
const search = ref('')
const contentArea = ref<HTMLElement | null>(null)
const filteredAccounts = computed(() => accounts.value.filter(item => item.label.toLowerCase().includes(search.value.toLowerCase())))
const renaming = ref<Account | null>(null)
const newLabel = ref('')
const routes = ref<any[]>([])
const measuring = ref(false)
let boundsObserver: ResizeObserver | undefined
let boundsFrame = 0
let disposed = false
const lineLabel = computed(() => {
  const route = settings.value?.cloudRoute || 'auto'
  const candidates = routes.value.filter(item => route === 'auto' || item.id === route)
  const best = candidates.find(item => item.available)
  return best ? `${best.label} ${best.latencyMs} ms` : measuring.value ? '检测中…' : routes.value.length ? '线路待检查' : '检查连接'
})
async function measureRoutes() {
  if (measuring.value) return
  measuring.value = true
  try { routes.value = await window.desktopAPI.measureRoutes() }
  catch (e: any) { error.value = e?.message || '线路检测失败' }
  finally { measuring.value = false }
}
function updateBounds() {
  cancelAnimationFrame(boundsFrame)
  boundsFrame = requestAnimationFrame(() => {
    if (disposed || !contentArea.value) return
    const { x, y, width, height } = contentArea.value.getBoundingClientRect()
    void window.desktopAPI.setContentBounds({ x, y, width, height }).catch(() => {})
  })
}
watch(collapsed, async value => { localStorage.setItem('hellodog:sidebar-collapsed', String(value)); await nextTick(); updateBounds() })
async function home() {
  selected.value = null
  await window.desktopAPI.focusPlatform({ platform: 'signal' })
}
function accountMenu(account: Account) { void window.desktopAPI.showAccountMenu(account.id) }
async function renameAccount(account: Account) {
  await window.desktopAPI.setOverlayOpen(true)
  renaming.value = account; newLabel.value = account.label
}
async function finishRename(save: boolean) {
  if (save && renaming.value) {
    const label = newLabel.value.trim().slice(0, 60)
    if (!label) return
    try { await window.desktopAPI.updateAccount(renaming.value.id, { label }); await reload() }
    catch (e: any) { error.value = e?.message || '名称保存失败'; return }
  }
  renaming.value = null
  await window.desktopAPI.setOverlayOpen(false)
}
function onShortcut(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') { event.preventDefault(); collapsed.value = !collapsed.value }
  if (event.key === 'Escape') {
    if (renaming.value) void finishRename(false)
    else if (showSettings.value) void closeSettings()
    else if (showProfile.value) void closeProfile()
  }
}

const settings = ref<any>(null)
const profile = ref<any>(null)
const profileSynced = ref(false)
const profileSync = new RemoteSnapshot<any>((value, synced) => { profile.value = value; profileSynced.value = synced })
const subscriptions: Array<() => void> = []
const languages = ref<any[]>([])
const liveStatuses = ref<Record<string, LiveStatus>>({})
const conversations = ref<Record<string, ConversationInfo>>({})
const metrics = ref<any>({ totalRequests: 0, providerCalls: 0, cacheHits: 0, dedupHits: 0, activeRequests: 0, queueDepth: 0, lastLatencyMs: 0, averageLatencyMs: 0 })
const controlFeedback = ref<{ state: 'idle'|'saving'|'saved'|'error'; message: string }>({ state: 'idle', message: '' })
let feedbackTimer: ReturnType<typeof setTimeout> | undefined
let metricsTimer: ReturnType<typeof setInterval> | undefined
let walletTimer: ReturnType<typeof setInterval> | undefined

const selectedIsSignal = computed(() => selected.value?.platform === 'signal')
const selectedConversation = computed(() => selected.value?.id ? conversations.value[selected.value.id] : undefined)
const contactPreference = computed(() => {
  const conversationId = selectedConversation.value?.id
  return conversationId && selected.value?.contactLanguages ? selected.value.contactLanguages[conversationId] : undefined
})
const localLanguage = computed(() => selected.value?.localLanguage || settings.value?.localLanguage || 'zh-CN')
const targetLanguage = computed(() => contactPreference.value?.language || selected.value?.targetLanguage || settings.value?.targetLanguage || 'en-US')
const receiveAutoTranslate = computed(() => selected.value?.receiveAutoTranslate ?? settings.value?.receiveAutoTranslate ?? true)
const sendAutoTranslate = computed(() => selected.value?.sendAutoTranslate ?? settings.value?.sendAutoTranslate ?? true)
const blockChineseSend = computed(() => selected.value?.blockChineseSend ?? settings.value?.blockChineseSend ?? true)
const groupTranslate = computed(() => selected.value?.groupTranslate ?? false)
const fontSize = computed(() => Number(selected.value?.fontSize || settings.value?.fontSize || 13))
const translationColor = computed(() => selected.value?.translationColor || settings.value?.translationColor || '#c8d4e4')
const apiConfigured = computed(() => {
  const provider = settings.value?.provider
  if (provider === 'openai') return true
  if (provider === 'deepl') return Boolean(String(settings.value?.deeplApiKey || '').trim())
  if (provider === 'google') return Boolean(String(settings.value?.googleApiKey || '').trim())
  return false
})
const channelName = computed(() => {
  if (settings.value?.provider === 'openai') return 'HelloDog 云端'
  if (settings.value?.provider === 'deepl') return 'DeepL'
  return 'Google Translate'
})
const serverName = computed(() => {
  if (settings.value?.provider === 'openai') return 'Cloudflare API'
  if (settings.value?.provider === 'deepl') return 'DeepL API'
  return 'Google API'
})
const serverStatusLabel = computed(() => settings.value?.provider === 'openai' ? '云端已配置' : (apiConfigured.value ? '密钥已配置' : '未配置'))
const selectedLiveStatus = computed<LiveStatus>(() => {
  if (!apiConfigured.value) return { state: 'error', message: '翻译服务未配置' }
  if (profileSynced.value && Number(profile.value?.remainingCharacters || 0) <= 0) return { state: 'error', message: '字符额度已用完' }
  if (selected.value?.id && liveStatuses.value[selected.value.id]) return liveStatuses.value[selected.value.id]
  return { state: 'ready', message: '等待翻译请求' }
})
const metricLabel = computed(() => {
  const delay = metrics.value?.lastLatencyMs ? `${metrics.value.lastLatencyMs} ms` : '待测'
  const queue = Number(metrics.value?.queueDepth || 0)
  const hits = Number(metrics.value?.cacheHits || 0) + Number(metrics.value?.dedupHits || 0)
  return `翻译 ${delay} · 队列 ${queue} · 缓存 ${hits}`
})
const contactLabel = computed(() => {
  const conversation = selectedConversation.value
  if (!conversation?.id) return ''
  const source = contactPreference.value?.source === 'manual' ? '手动' : contactPreference.value?.source === 'auto' ? '自动识别' : '账号默认'
  return `${conversation.name || '当前联系人'} · ${source}`
})
const remainingCharsLabel = computed(() => profile.value
  ? `${new Intl.NumberFormat('zh-CN').format(Math.max(0, Number(profile.value.remainingCharacters || 0)))}${profileSynced.value ? '' : '（待同步）'}`
  : '未同步')
const quotaLow = computed(() => {
  const total = Number(profile.value?.totalCharacters || 0)
  const remaining = Number(profile.value?.remainingCharacters || 0)
  return total > 0 && remaining / total <= 0.1
})

function cloudProfileFromState(state: any) {
  if (!state?.wallet || !Number.isFinite(Number(state.wallet.balance))) throw new Error('余额尚未同步。')
  const wallet = state.wallet
  const cloudProfile = state?.profile || {}
  const user = state?.user || {}
  const remaining = Number(wallet.balance || 0)
  const used = Number(wallet.lifetime_debited || 0)
  const credited = Number(wallet.lifetime_credited || 0)
  return {
    username: cloudProfile.username || '',
    email: user.email || cloudProfile.email || '',
    planName: cloudProfile.plan_code || 'free',
    totalCharacters: Math.max(remaining + used, credited, 0),
    usedCharacters: used,
    remainingCharacters: remaining,
    registeredAt: cloudProfile.created_at ? Date.parse(cloudProfile.created_at) : 0,
    updatedAt: wallet.updated_at ? Date.parse(wallet.updated_at) : Date.now(),
    cloud: true
  }
}

async function reload() {
  accounts.value = await window.desktopAPI.listAccounts()
  if (selected.value) {
    const current = accounts.value.find((item) => item.id === selected.value?.id)
    if (current) selected.value = current
  }
}

async function reloadSettings() {
  settings.value = await window.desktopAPI.getSettings()
  if (!languages.value.length) languages.value = await window.desktopAPI.getLanguages()
}

async function reloadProfile() {
  return profileSync.refresh(async () => cloudProfileFromState(await cloudApi.me()))
}

async function reloadMetrics() {
  try { metrics.value = await window.desktopAPI.getTranslationMetrics() } catch { /* ignore transient UI metric errors */ }
}

async function addWhatsApp() {
  const account = await window.desktopAPI.addAccount({ platform: 'whatsapp' })
  await reload()
  await select(account)
}

async function addSignalRecord(signalAccount?: string) {
  const account = await window.desktopAPI.addAccount({ platform: 'signal', signalAccount })
  await reload()
  await select(account)
}

async function select(account: Account) {
  selected.value = account
  await nextTick()
  updateBounds()
  controlFeedback.value = { state: 'idle', message: '' }
  try { await window.desktopAPI.focusPlatform({ platform: account.platform, accountId: account.id }) }
  catch (e: any) { error.value = e?.message || '页面加载失败，请使用右键菜单刷新。' }
}

async function remove(account: Account) {
  await window.desktopAPI.removeAccount(account.id)
  if (selected.value?.id === account.id) {
    selected.value = null
    await window.desktopAPI.focusPlatform({ platform: 'signal' })
  }
  await reload()
}

function setFeedback(state: 'idle'|'saving'|'saved'|'error', message: string) {
  controlFeedback.value = { state, message }
  if (feedbackTimer) clearTimeout(feedbackTimer)
  if (state === 'saved') feedbackTimer = setTimeout(() => { controlFeedback.value = { state: 'idle', message: '' } }, 1800)
}

async function patchSelected(patch: Record<string, unknown>) {
  if (!selected.value) return
  setFeedback('saving', '正在保存…')
  try {
    const updated = await window.desktopAPI.updateAccount(selected.value.id, patch)
    if (!updated) throw new Error('保存失败')
    selected.value = updated
    const index = accounts.value.findIndex((item) => item.id === updated.id)
    if (index >= 0) accounts.value[index] = updated
    setFeedback('saved', '设置已保存')
  } catch (e: any) {
    setFeedback('error', e?.message || '设置保存失败')
  }
}

function setStringField(field: string, event: Event) {
  const value = (event.target as HTMLSelectElement | HTMLInputElement).value
  void patchSelected({ [field]: value })
}

function setNumberField(field: string, event: Event) {
  const value = Number((event.target as HTMLSelectElement).value)
  void patchSelected({ [field]: value })
}

async function setTargetLanguage(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  const account = selected.value
  const conversation = selectedConversation.value
  if (account?.platform === 'whatsapp' && conversation?.id) {
    setFeedback('saving', '正在保存联系人语言…')
    try {
      const updated = await window.desktopAPI.setContactLanguage(account.id, conversation.id, value, conversation.name)
      if (updated) {
        selected.value = updated
        const index = accounts.value.findIndex((item) => item.id === updated.id)
        if (index >= 0) accounts.value[index] = updated
      }
      setFeedback('saved', '联系人语言已保存')
    } catch (e: any) {
      setFeedback('error', e?.message || '联系人语言保存失败')
    }
    return
  }
  await patchSelected({ targetLanguage: value })
}

async function openSettings() {
  await window.desktopAPI.setOverlayOpen(true)
  showSettings.value = true
}

async function closeSettings() {
  showSettings.value = false
  await window.desktopAPI.setOverlayOpen(false)
  void reloadSettings()
  void reloadProfile()
}

async function openProfile() {
  await window.desktopAPI.setOverlayOpen(true)
  showProfile.value = true
  void reloadProfile()
}

async function closeProfile() {
  showProfile.value = false
  await window.desktopAPI.setOverlayOpen(false)
  void reloadProfile()
}

function onProfileUpdated(next: any) {
  if (next?.wallet) profileSync.accept(cloudProfileFromState(next))
  else void reloadProfile()
}

onMounted(async () => {
  window.addEventListener('keydown', onShortcut)
  boundsObserver = new ResizeObserver(updateBounds)
  if (contentArea.value) boundsObserver.observe(contentArea.value)
  updateBounds()
  void measureRoutes()
  subscriptions.push(window.desktopAPI.onAccountAction(async (event: any) => {
    const account = accounts.value.find(item => item.id === event.accountId)
    if (event.action === 'rename' && account) await renameAccount(account)
    if (event.action === 'updated') await reload()
    if (event.action === 'removed') { if (selected.value?.id === event.accountId) await home(); await reload() }
    if (event.action === 'home') await home()
    if (event.action === 'diagnose') await openSettings()
  }))
  metricsTimer = setInterval(() => { void reloadMetrics() }, 1500)
  walletTimer = setInterval(() => { void reloadProfile() }, 15000)
  subscriptions.push(window.desktopAPI.onWhatsAppConversation((info: any) => {
    if (!info?.accountId || !info?.conversationId) return
    conversations.value = { ...conversations.value, [info.accountId]: { id: info.conversationId, name: info.conversationName } }
  }))
  subscriptions.push(window.desktopAPI.onContactLanguage(() => { void reload() }))
  subscriptions.push(window.desktopAPI.onTranslatorStatus((status: any) => {
    if (!status?.accountId) return
    liveStatuses.value = {
      ...liveStatuses.value,
      [status.accountId]: {
        state: status.state || 'ready',
        message: status.message || '翻译器就绪',
        at: status.at || Date.now()
      }
    }
    if (status?.state === 'success' || status?.settled) void reloadProfile()
  }))
  subscriptions.push(window.desktopAPI.onTranslatorError((message: string) => {
    error.value = message
    setTimeout(() => error.value = '', 6500)
  }))
  void reloadProfile()
  await Promise.allSettled([reload(), reloadSettings(), reloadMetrics()])
})

onUnmounted(() => {
  disposed = true
  window.removeEventListener('keydown', onShortcut)
  boundsObserver?.disconnect()
  cancelAnimationFrame(boundsFrame)
  subscriptions.forEach(unsubscribe => unsubscribe())
  if (metricsTimer) clearInterval(metricsTimer)
  if (walletTimer) clearInterval(walletTimer)
  if (feedbackTimer) clearTimeout(feedbackTimer)
})
</script>

<template>
  <div class="app-shell" :class="{ 'sidebar-collapsed': collapsed }">
    <aside class="sidebar">
      <button class="brand" @click="home" title="HelloDog 工作台"><img src="/hellodog-icon.webp" alt="HelloDog" /><span><b>HelloDog</b><small>让每一句，都被听懂。</small></span></button>
      <div class="sidebar-heading"><span>工作空间</span><button class="icon-button collapse-button" :aria-expanded="!collapsed" :title="collapsed ? '展开侧栏 (Ctrl+B)' : '收起侧栏 (Ctrl+B)'" @click="collapsed = !collapsed"><UiIcon name="panel" /></button></div>
      <button class="nav-button" :class="{ active: !selected }" @click="home" title="工作台"><UiIcon name="home" /><span>工作台</span></button>
      <div class="sidebar-heading account-heading"><span>我的账号 <b>{{ accounts.length }}</b></span></div>
      <label v-if="!collapsed" class="account-search"><UiIcon name="search" /><input v-model="search" placeholder="搜索账号" aria-label="搜索账号" /></label>
      <div class="account-list">
        <div v-for="account in filteredAccounts" :key="account.id" class="account-row" :class="{ active: selected?.id === account.id }" @contextmenu.prevent="accountMenu(account)">
          <button class="account" :title="account.label" @click="select(account)" @keydown.shift.f10.prevent="accountMenu(account)">
            <span class="platform-avatar" :class="account.platform">{{ account.platform === 'whatsapp' ? 'W' : 'S' }}</span><span class="account-label"><b>{{ account.label }}</b><small>{{ account.platform === 'whatsapp' ? 'WhatsApp' : 'Signal' }}</small></span>
          </button><button v-if="!collapsed" class="icon-button account-more" :aria-label="account.label + ' 的更多操作'" @click="accountMenu(account)"><UiIcon name="more" /></button>
        </div>
        <p v-if="!filteredAccounts.length && !collapsed" class="sidebar-hint">{{ search ? '没有匹配的账号' : '添加账号，开始对话。' }}</p>
      </div>
      <div class="add-accounts"><button class="add wa" @click="addWhatsApp" title="添加 WhatsApp"><UiIcon name="plus" /><span>添加 WhatsApp</span></button><button class="add signal" @click="addSignalRecord()" title="添加 Signal"><UiIcon name="plus" /><span>添加 Signal</span></button></div>
      <div class="sidebar-bottom">
        <button class="profile-btn" @click="openProfile" title="个人中心与字符余额"><UiIcon name="user" /><span><b>个人中心</b><small>剩余 {{ remainingCharsLabel }} 字符</small></span></button>
        <button class="settings-btn" @click="openSettings" title="设置与连接诊断"><UiIcon name="settings" /><span>设置与连接</span></button>
        <small class="version-label">{{ collapsed ? '0.5.0' : 'HelloDog · v0.5.0' }}</small>
      </div>
    </aside>
    <div class="workspace">
      <header class="workspace-header"><div><span class="workspace-kicker">HELLODOG WORKSPACE</span><h1>{{ selected?.label || '你的聊天，世界都听得懂。' }}</h1></div><div class="workspace-header-actions"><button class="connection-button" @click="openSettings" title="查看实测线路与连接诊断"><UiIcon name="signal" />{{ lineLabel }}</button><button v-if="selected" class="icon-button" title="账号操作" @click="accountMenu(selected)"><UiIcon name="more" /></button></div></header>
      <section v-if="selected" class="account-toolbar">
        <div class="language-control"><label><span>我使用的语言</span><select :value="localLanguage" @change="setStringField('localLanguage', $event)"><option v-for="language in languages.filter(x => x.code !== 'auto')" :key="language.code" :value="language.code">{{ language.zhName || language.name }}</option></select></label><span class="language-arrow">⇄</span><label><span>{{ contactLabel || '对方的语言' }}</span><select :value="targetLanguage" @change="setTargetLanguage"><option v-for="language in languages.filter(x => x.code !== 'auto')" :key="language.code" :value="language.code">{{ language.zhName || language.name }}</option></select></label></div>
        <div class="translation-toggles"><label><input type="checkbox" :checked="receiveAutoTranslate" @change="patchSelected({ receiveAutoTranslate: !receiveAutoTranslate })" />接收翻译</label><label><input type="checkbox" :checked="sendAutoTranslate" @change="patchSelected({ sendAutoTranslate: !sendAutoTranslate })" />发送翻译</label><label><input type="checkbox" :checked="blockChineseSend" @change="patchSelected({ blockChineseSend: !blockChineseSend })" />拦截中文原文</label><label><input type="checkbox" :checked="groupTranslate" @change="patchSelected({ groupTranslate: !groupTranslate })" />群组翻译</label></div>
        <div class="display-controls"><label>译文字号<select :value="fontSize" @change="setNumberField('fontSize', $event)"><option v-for="size in [12,13,14,15,16,18]" :key="size" :value="size">{{ size }} px</option></select></label><label title="译文颜色">颜色<input type="color" :value="translationColor" @change="setStringField('translationColor', $event)" /></label><button class="text-button" @click="patchSelected({ translationsVisible: selected.translationsVisible === false })">{{ selected.translationsVisible === false ? '显示译文' : '隐藏译文' }}</button></div>
      </section>
      <div v-if="selected" class="workspace-status"><div class="live-status" :class="selectedLiveStatus.state"><i></i><span>{{ selectedLiveStatus.message }}</span></div><span>{{ channelName }}</span><span class="metric-text">{{ metricLabel }}</span><span class="save-feedback" :class="controlFeedback.state" role="status">{{ controlFeedback.message }}</span><span class="quota-text" :class="{ low: quotaLow }">余 {{ remainingCharsLabel }} 字符</span></div>
      <main ref="contentArea" class="content" :class="{ 'signal-content': selectedIsSignal }">
        <SignalView v-if="selectedIsSignal" :key="selected!.id" :account-record="selected!" :user-id="props.userId" @linked="reload" />
        <div v-else-if="!selected" class="welcome">
          <div class="welcome-copy"><span class="eyebrow">SAY HELLO, GO FURTHER.</span><h2>让交流少一点距离。<br /><em>多一点 Hello。</em></h2><p>连接你的聊天账号，用熟悉的语言，聊更远的世界。</p><div class="welcome-actions"><button class="primary" @click="addWhatsApp"><UiIcon name="plus" />添加 WhatsApp</button><button class="secondary" @click="addSignalRecord()">添加 Signal</button></div><small>已有账号？从左侧选择，继续上一次对话。</small></div><img class="welcome-dog" src="/hellodog-icon.webp" alt="HelloDog 小狗" />
          <div class="welcome-cards"><button @click="openSettings"><UiIcon name="signal" /><b>先检查连接</b><p>检测线路、登录与翻译服务，定位问题。</p><span>打开连接诊断 →</span></button><button @click="openProfile"><UiIcon name="user" /><b>字符余额，一目了然</b><p>剩余 {{ remainingCharsLabel }} 字符，查看真实消费记录。</p><span>打开个人中心 →</span></button><article><UiIcon name="shield" /><b>发送前，多一道确认</b><p>失败保留草稿，发送结果不明确时由你确认。</p><span>账号右键 · 更多实用操作</span></article></div>
        </div>
      </main>
    </div>
    <SettingsPanel v-if="showSettings" @close="closeSettings" />
    <PersonalCenter v-if="showProfile" @close="closeProfile" @updated="onProfileUpdated" />
    <div v-if="renaming" class="modal-backdrop" @click.self="finishRename(false)"><form class="panel rename-panel" @submit.prevent="finishRename(true)"><header><h2>给账号取个名字</h2><button type="button" @click="finishRename(false)" aria-label="关闭">×</button></header><label>账号名称<input v-model="newLabel" maxlength="60" required autofocus /></label><footer><button type="button" class="secondary" @click="finishRename(false)">取消</button><button class="primary" type="submit">保存名称</button></footer></form></div>
    <div v-if="error" class="toast" role="alert">{{ error }}<button @click="error = ''" aria-label="关闭提示">×</button></div>
  </div>
</template>
