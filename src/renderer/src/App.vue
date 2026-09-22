<script setup lang="ts">
import { lowCharacterBalance } from "../../shared/characterQuota"
import { t, uiLanguage, languageName, uiError } from './lib/uiLocale'

import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import AccountSetup from './components/AccountSetup.vue'
import UiIcon from './components/UiIcon.vue'
import GoogleVoiceLauncher from './components/GoogleVoiceLauncher.vue'
import GoogleVoiceNavigation from './components/GoogleVoiceNavigation.vue'
import GoogleVoiceContent from './components/GoogleVoiceContent.vue'
import GoogleVoiceTranslationSetup from './components/GoogleVoiceTranslationSetup.vue'
import GoogleVoiceWindowSetup from './components/GoogleVoiceWindowSetup.vue'
import AccountNavigation from './components/AccountNavigation.vue'
import WorkspaceTools from './components/WorkspaceTools.vue'
import TranslationChannelSelector from './components/TranslationChannelSelector.vue'
import ConfirmColor from './components/ConfirmColor.vue'
import NotificationCenter from './components/NotificationCenter.vue'
import TranslationQualityEditor from './components/TranslationQualityEditor.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import PersonalCenter from './components/PersonalCenter.vue'
import SignalView from './components/SignalView.vue'
import SignalNativeView from './components/SignalNativeView.vue'
import { cloudApi } from './lib/cloudApi'
import { AccountWrites } from './lib/accountWrites'
import { RemoteSnapshot } from './lib/remoteSnapshot'
import { prepareBeforeRestart } from './lib/restartState'
import { orderedAccounts } from '../../shared/accountOrder'
import { useGoogleVoiceWorkspace, type GoogleVoiceWindow, type GoogleVoiceWindowOptions } from './lib/googleVoiceWorkspace'

const props = defineProps<{ userId: string }>()

type ContactPreference = { language?: string; translationQuality?: any; name?: string; updatedAt: number; source?: 'manual'|'auto' }
type Account = {
  id: string
  platform: 'whatsapp'|'signal'
  label: string
  translationProvider?: 'deepseek' | 'openai'
  signalAccount?: string
  signalEngine?: 'cli' | 'desktop'
  localLanguage?: string
  targetLanguage?: string
  receiveAutoTranslate?: boolean
  sendAutoTranslate?: boolean
  blockChineseSend?: boolean
  groupTranslate?: boolean
  fontSize?: number
  translationsVisible?: boolean
  historyMode?: 'new' | 'manual' | 'visible'
  proxy?: any
  toolbarCollapsed?: boolean
  runtimeMode?: 'receiving' | 'paused'
  translationQuality?: any
  pinned?: boolean
  tabOrder?: number
  group?: string
  zoomFactor?: number
  translationColor?: string
  contactLanguages?: Record<string, ContactPreference>
}

type LiveStatus = { state: 'ready'|'working'|'success'|'error'; message: string; at?: number }
type ConversationInfo = { id: string; name?: string }

const accounts = ref<Account[]>([])
const selected = ref<Account | null>(null)
const setup = ref<{ platform: 'whatsapp' | 'signal'; account?: Account } | null>(null)
const showSettings = ref(false)
const showQuality = ref(false)
async function openQuality() { await window.desktopAPI.setOverlayOpen(true); showQuality.value = true }
async function closeQuality() { showQuality.value = false; await window.desktopAPI.setOverlayOpen(false) }
async function qualityUpdated(account: Account) { mergeAccountFields(account.id, account); await reloadSettings() }
const showProfile = ref(false)
const showNotices = ref(false), notices = ref<any>({notices:[],unread:0})
async function openNotices(){await window.desktopAPI.setOverlayOpen(true);showNotices.value=true}
async function closeNotices(){showNotices.value=false;await window.desktopAPI.setOverlayOpen(false)}
const runtimeHealth = ref<any>(null)
const settingsInitialTab = ref<'translation' | 'updates'>('translation')
const chatPageStates = ref<Record<string, 'loading' | 'ready' | 'error'>>({})
const refreshingAccounts = ref(new Set<string>())
let accountSelection = 0
const undoChange = ref<{id:string; patch:Record<string,unknown>} | null>(null)
async function refreshHealth() { try { runtimeHealth.value = await window.desktopAPI.reliabilityStatus() } catch {} }
function accountSummary(id: string) { const status = runtimeHealth.value?.accounts?.find((item:any) => item.id === id); const labels:Record<string,string> = {paused:t('已暂停'),receiving:t('接收已开启'),'page-ready':t('聊天界面可用'),closed:t('未打开'),loading:t('连接中'),disconnected:t('连接中断'),offline:t('离线'),'login-required':t('需登录')}; return status ? (labels[status.state] || t('待核对')) + ' · ' + (status.proxy === 'configured' ? t('独立代理') : status.proxy === 'unsupported' ? t('代理未支持') : t('系统网络')) + t(' · 翻译待处理 ') + status.pendingTranslations : t('状态待核对') }
const error = ref('')
const restarting = ref(false)
async function restartApp() {
  if (restarting.value) return
  restarting.value = true
  try { await window.desktopAPI.restartApp() }
  catch (e: any) { error.value = e?.message || t('重启未完成，软件仍在运行。'); restarting.value = false }
}
const collapsed = ref(false)
const search = ref('')
const finderOpen = ref(false)
async function showAccountFinder() { finderOpen.value = true; await window.desktopAPI.setOverlayOpen(true); await nextTick(); document.querySelector<HTMLInputElement>('.compact-finder input')?.focus() }
async function closeAccountFinder() { finderOpen.value = false; await window.desktopAPI.setOverlayOpen(false) }
async function selectFromFinder(account: Account) { await closeAccountFinder(); await select(account) }
const contentArea = ref<HTMLElement | null>(null)
const googleVoice = useGoogleVoiceWorkspace({
  api: () => window.desktopAPI,
  beforeFocus: async () => { await nextTick(); if (contentArea.value) { const { x, y, width, height } = contentArea.value.getBoundingClientRect(); await window.desktopAPI.setContentBounds({ x, y, width, height }) } },
  reportError: message => { error.value = message }
})
const { active: googleVoiceActive, windows: googleVoiceWindows, selectedId: googleVoiceSelectedId, state: googleVoiceState, message: googleVoiceMessage, translationNotice: googleVoiceTranslationNotice, busy: googleVoiceBusy } = googleVoice
const voiceRenaming = ref<GoogleVoiceWindow | null>(null), voiceNewLabel = ref(''), voiceRenameInput = ref<HTMLInputElement>()
const voiceTranslationTarget = ref<GoogleVoiceWindow | null>(null)
const voiceWindowSetup = ref<{ record?: GoogleVoiceWindow } | null>(null)
const chatOverlayOpen = computed(() => Boolean(setup.value || showSettings.value || showQuality.value || showProfile.value || showNotices.value || finderOpen.value || renaming.value || voiceRenaming.value || voiceTranslationTarget.value || voiceWindowSetup.value))
async function openGoogleVoiceWindowSetup(record?: GoogleVoiceWindow) {
  if (googleVoiceBusy.value) return
  try { await window.desktopAPI.setOverlayOpen(true); error.value = ''; voiceWindowSetup.value = { record } }
  catch (e: any) { error.value = uiError(e?.message) }
}
async function closeGoogleVoiceWindowSetup() {
  voiceWindowSetup.value = null
  try { await window.desktopAPI.setOverlayOpen(false) } catch (e: any) { error.value = uiError(e?.message) }
}
async function saveGoogleVoiceWindow(input: GoogleVoiceWindowOptions) {
  error.value = ''
  const id = voiceWindowSetup.value?.record?.id
  const previousIds = new Set(googleVoice.windows.value.map(record => record.id))
  const saved = id ? await googleVoice.configure(id, input) : await googleVoice.add(input)
  if (!saved) { const failure = error.value || t('窗口设置未保存，请重试。'); error.value = ''; throw new Error(failure) }
  if (!id && !googleVoiceActive.value) { const createdId = googleVoice.windows.value.find(record => !previousIds.has(record.id))?.id; await googleVoice.enter(); if (createdId) await googleVoice.focus(createdId) }
  error.value = ''
  return saved
}
async function openGoogleVoiceTranslation() {
  if (!googleVoice.selected.value) return
  try { await window.desktopAPI.setOverlayOpen(true); voiceTranslationTarget.value = googleVoice.selected.value }
  catch (e: any) { error.value = uiError(e?.message) }
}
async function closeGoogleVoiceTranslation() {
  voiceTranslationTarget.value = null
  try { await window.desktopAPI.setOverlayOpen(false) } catch (e: any) { error.value = uiError(e?.message) }
}
async function openGoogleVoiceSettings(){await closeGoogleVoiceTranslation();await openSettings()}
async function renameGoogleVoice(record: GoogleVoiceWindow) {
  if (!record || googleVoiceBusy.value) return
  try {
    await window.desktopAPI.setOverlayOpen(true)
    voiceRenaming.value = record; voiceNewLabel.value = record.label
    await nextTick(); voiceRenameInput.value?.focus(); voiceRenameInput.value?.select()
  } catch (e: any) { error.value = uiError(e?.message) }
}
async function finishGoogleVoiceRename(save: boolean) {
  if (googleVoiceBusy.value) return
  if (save && voiceRenaming.value && !await googleVoice.rename(voiceRenaming.value.id, voiceNewLabel.value)) return
  voiceRenaming.value = null
  try { await window.desktopAPI.setOverlayOpen(false) } catch (e: any) { error.value = uiError(e?.message) }
}
const platformFilter = ref('all'), groupFilter = ref('all')
const unread = ref<Record<string, number>>({})
const googleVoiceUnread = computed(() => Object.entries(unread.value).filter(([id]) => /^gv-[a-f0-9-]{36}$/.test(id)).reduce((sum, [, count]) => sum + count, 0))
const activePlatform = ref<'whatsapp'|'signal'>('whatsapp')
const lastAccounts = new Map<string,string>()
const navigationPosition = computed(() => settings.value?.accountNavigationPosition === 'side' ? 'side' : 'top')
const platformAccounts = computed(() => orderedAccounts(accounts.value.filter(account => account.platform === activePlatform.value)))
const orderingAccounts = ref(false)
async function reorderAccounts(ids: string[]) {
  if (orderingAccounts.value) return
  orderingAccounts.value = true
  const platform = activePlatform.value
  try {
    const saved: Account[] = await accountWrites.enqueue(() => window.desktopAPI.reorderAccounts(platform, ids))
    // Only merge order fields: an unrelated settings save may have completed meanwhile.
    for (const account of saved) {
      const current = accounts.value.find(item => item.id === account.id)
      if (current) current.tabOrder = account.tabOrder
    }
  } catch { error.value = t('账号顺序未保存，请重试。') }
  finally { orderingAccounts.value = false }
}
function platformUnread(platform: string) { return accounts.value.filter(account => account.platform === platform).reduce((sum,account) => sum + (unread.value[account.id] || 0),0) }
async function choosePlatform(platform: 'whatsapp'|'signal') {
  const matching = accounts.value.filter(account => account.platform === platform)
  const account = matching.find(account => account.id === lastAccounts.get(platform)) || matching[0]
  if (account) await select(account); else await openSetup(platform)
}
function platformMenu(platform:'whatsapp'|'signal') { const account=accounts.value.find(account=>account.id===lastAccounts.get(platform)&&account.platform===platform)||accounts.value.find(account=>account.platform===platform); if(account)accountMenu(account);else void openSetup(platform) }
async function openWebsite() { try { await window.desktopAPI.openOfficialWebsite() } catch { error.value = t('官网暂时无法打开，请稍后重试。') } }
const groups = computed(() => [...new Set(accounts.value.map(item => item.group || '').filter(Boolean))])
const filteredAccounts = computed(() => accounts.value.filter(item => item.label.toLowerCase().includes(search.value.toLowerCase()) && (platformFilter.value === 'all' || item.platform === platformFilter.value) && (groupFilter.value === 'all' || (item.group || '') === groupFilter.value)).sort((a,b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))))

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
  return best ? `${t(best.label)} ${best.latencyMs} ms` : measuring.value ? t('检测中…') : routes.value.length ? t('线路待检查') : t('检查连接')
})
async function measureRoutes() {
  if (measuring.value) return
  measuring.value = true
  try { routes.value = await window.desktopAPI.measureRoutes() }
  catch (e: any) { error.value = e?.message || t('线路检测失败') }
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
async function syncContentBounds() {
  await nextTick()
  if (disposed || !contentArea.value) return
  const { x, y, width, height } = contentArea.value.getBoundingClientRect()
  if (width > 0 && height > 0) await window.desktopAPI.setContentBounds({ x, y, width, height })
}
async function refreshCurrentChat() {
  if (chatOverlayOpen.value) return
  if (googleVoiceActive.value) { await googleVoice.refresh(); return }
  const account = selected.value
  if (!account || refreshingAccounts.value.has(account.id)) return
  refreshingAccounts.value.add(account.id)
  try {
    await syncContentBounds()
    if (selected.value?.id !== account.id || googleVoiceActive.value || chatOverlayOpen.value) return
    await window.desktopAPI.refreshAccount(account.id)
  } catch (e: any) {
    if (selected.value?.id === account.id && !googleVoiceActive.value) error.value = uiError(e?.message) || t('刷新未完成，草稿已保留。')
  } finally { refreshingAccounts.value.delete(account.id) }
}
watch(collapsed, async value => { localStorage.setItem('hellodog:sidebar-collapsed', String(value)); await nextTick(); updateBounds() })
async function home() {
  accountSelection++
  googleVoice.leave()
  selected.value = null
  void googleVoice.listForHome()
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
    catch (e: any) { error.value = e?.message || t('名称保存失败'); return }
  }
  renaming.value = null
  await window.desktopAPI.setOverlayOpen(false)
}
function onShortcut(event: KeyboardEvent) {
  if (event.key === 'F5' || (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') {
    event.preventDefault()
    void refreshCurrentChat()
    return
  }
  if ((event.ctrlKey || event.metaKey) && ((event.shiftKey && event.key.toLowerCase() === 'f') || event.key.toLowerCase() === 'k')) { event.preventDefault(); void showAccountFinder(); }
  if ((event.ctrlKey || event.metaKey) && event.key === '/') { event.preventDefault(); void openSettings('updates'); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') { event.preventDefault(); collapsed.value = !collapsed.value }
  if (event.key === 'Escape') {
    if (voiceTranslationTarget.value) { void closeGoogleVoiceTranslation(); return }
    if (voiceRenaming.value) { void finishGoogleVoiceRename(false); return }
    if (showNotices.value) { void closeNotices(); return }
    if (showQuality.value) { void closeQuality(); return }
    if (finderOpen.value) void closeAccountFinder()
    else if (renaming.value) void finishRename(false)
    else if (showSettings.value) void closeSettings()
    else if (showProfile.value) void closeProfile()
  }
}

const settings = ref<any>(null)
type TranslationProvider = 'deepseek' | 'openai'
const translationChannels = ref({ defaultProvider: 'deepseek' as TranslationProvider, deepseek: { available: false, reason: t('正在检查通道') }, openai: { available: false, reason: t('正在检查通道') } })
const channelsLoading = ref(false)
let channelsRequest: Promise<void> | undefined
function loadTranslationChannels(refresh = false): Promise<void> {
  if (channelsRequest) return refresh ? channelsRequest.then(() => loadTranslationChannels(true)) : channelsRequest
  channelsLoading.value = true
  channelsRequest = (async () => {
    try {
      const value = await window.desktopAPI.translationChannels(refresh)
      if (!value || !['deepseek','openai'].includes(value.defaultProvider) || typeof value.deepseek?.available !== 'boolean' || typeof value.openai?.available !== 'boolean') throw new Error('Invalid channel status')
      if (!disposed) translationChannels.value = value
    }
    catch { if (!disposed) translationChannels.value = { defaultProvider: 'deepseek', deepseek: { available: false, reason: t('暂时无法确认通道，请检查连接') }, openai: { available: false, reason: t('暂时无法确认通道，请检查连接') } } }
    finally { channelsLoading.value = false; channelsRequest = undefined }
  })()
  return channelsRequest
}
const channelWindowId = computed(() => googleVoiceActive.value ? googleVoiceSelectedId.value : selected.value?.id)
const activeTranslationChannels = computed(() => translationChannels.value)
const windowTranslationProvider = computed<TranslationProvider>(() => (googleVoiceActive.value ? googleVoice.selected.value?.translationProvider : selected.value?.translationProvider) || 'deepseek')
async function saveTranslationProvider(provider: TranslationProvider) {
  const id = channelWindowId.value, voice = googleVoiceActive.value
  if (!id || !translationChannels.value[provider].available) throw new Error(t('此通道暂不可用'))
  if (voice) { if (!await googleVoice.setTranslationProvider(id, provider)) throw new Error(t('切换未完成，保留原通道')); return }
  const saved: Account = await accountWrites.enqueue(() => window.desktopAPI.updateAccount(id, { translationProvider: provider }))
  if (!saved || saved.translationProvider !== provider) throw new Error(t('切换未完成，保留原通道'))
  mergeAccountFields(id, { translationProvider: saved.translationProvider })
}
async function saveTranslationColor(value: string) {
  const id = selected.value?.id
  if (!id) throw new Error(t('请先选择窗口'))
  const saved: Account = await accountWrites.enqueue(() => window.desktopAPI.updateAccount(id, { translationColor: value }))
  if (!saved) throw new Error(t('颜色未保存，请重试'))
  mergeAccountFields(id, { translationColor: saved.translationColor })
}
watch(navigationPosition, async () => { await nextTick(); updateBounds() })
const profile = ref<any>(null)
const profileSynced = ref(false)
const profileSync = new RemoteSnapshot<any>((value, synced) => { profile.value = value; profileSynced.value = synced })
const subscriptions: Array<() => void> = []
const languages = ref<any[]>([])
const liveStatuses = ref<Record<string, LiveStatus>>({})
const conversations = ref<Record<string, ConversationInfo>>({})
const controlFeedback = ref<{ state: 'idle'|'saving'|'saved'|'error'; message: string }>({ state: 'idle', message: '' })
let feedbackTimer: ReturnType<typeof setTimeout> | undefined
let healthTimer: ReturnType<typeof setInterval> | undefined
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
const blockChineseSend = computed(() => true)
const groupTranslate = computed(() => selected.value?.groupTranslate ?? false)
const fontSize = computed(() => Number(selected.value?.fontSize || settings.value?.fontSize || 13))
const translationColor = computed(() => selected.value?.translationColor || settings.value?.translationColor || '#c8d4e4')
const selectedLiveStatus = computed<LiveStatus>(() => {
  if (selected.value?.platform === 'whatsapp') {
    const page = chatPageStates.value[selected.value.id]
    if (page === 'loading') return { state: 'working', message: t('正在打开聊天…') }
    if (page === 'error') return { state: 'error', message: t('聊天页面连接中断，请刷新重试。') }
  }
  if (profileSynced.value && Number(profile.value?.remainingCharacters || 0) <= 0) return { state: 'error', message: t('字符额度已用完') }
  if (selected.value?.id && liveStatuses.value[selected.value.id]) return liveStatuses.value[selected.value.id]
  return { state: 'ready', message: t('等待翻译请求') }
})
const contactLabel = computed(() => {
  const conversation = selectedConversation.value
  if (!conversation?.id) return ''
  const source = contactPreference.value?.source === 'manual' ? t('手动') : contactPreference.value?.source === 'auto' ? t('自动识别') : t('账号默认')
  return `${conversation.name || t('当前联系人')} · ${source}`
})
const remainingCharsLabel = computed(() => profile.value
  ? `${new Intl.NumberFormat(uiLanguage.value).format(Math.max(0, Number(profile.value.remainingCharacters || 0)))}${profileSynced.value ? '' : t('（待同步）')}`
  : t('未同步'))
const quotaLow = computed(() => lowCharacterBalance(profile.value?.remainingCharacters))

function cloudProfileFromState(state: any) {
  if (!state?.wallet || !Number.isFinite(Number(state.wallet.balance))) throw new Error(t('余额尚未同步。'))
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
  void loadTranslationChannels(true)
  if (!languages.value.length) languages.value = await window.desktopAPI.getLanguages()
}

function invalidateProfile() { void profileSync.invalidate(async () => cloudProfileFromState(await cloudApi.me())) }
async function reloadProfile() {
  return profileSync.refresh(async () => cloudProfileFromState(await cloudApi.me()))
}


async function openSetup(platform: 'whatsapp' | 'signal', account?: Account) {
  await window.desktopAPI.setOverlayOpen(true)
  setup.value = { platform, account }
}
async function closeSetup() { setup.value = null; await window.desktopAPI.setOverlayOpen(false) }
async function setupSaved(account: Account) { await closeSetup(); await reload(); await select(account) }
async function addWhatsApp() { await openSetup('whatsapp') }
async function addSignalRecord() { await openSetup('signal') }

async function select(account: Account) {
  const revision = ++accountSelection
  const current = () => !disposed && revision === accountSelection && selected.value?.id === account.id && !googleVoiceActive.value
  const started = performance.now()
  googleVoice.leave()
  selected.value = account
  activePlatform.value = account.platform
  lastAccounts.set(account.platform, account.id)
  if (account.platform === 'whatsapp' && !chatPageStates.value[account.id]) chatPageStates.value[account.id] = 'loading'
  controlFeedback.value = { state: 'idle', message: '' }
  try {
    await syncContentBounds()
    if (!current()) return
    const result = await window.desktopAPI.focusPlatform({ platform: account.platform, accountId: account.id })
    if (!current()) return
    if (account.platform === 'whatsapp' && result?.state === 'ready') chatPageStates.value[account.id] = 'ready'
    await window.desktopAPI.recordSwitchDuration(performance.now() - started)
  } catch (e: any) {
    if (!current()) return
    if (account.platform === 'whatsapp') chatPageStates.value[account.id] = 'error'
    error.value = e?.message || t('页面加载失败，请重新打开此账号。')
  }
}
async function resumeSelected() {
  const account = selected.value
  if (!account) return
  try {
    await window.desktopAPI.setAccountMode(account.id, 'receiving')
    await reload()
    if (selected.value?.id === account.id && !googleVoiceActive.value) await select(selected.value)
  } catch (e: any) { error.value = uiError(e?.message) || t('恢复未完成，请重试。') }
}

async function remove(account: Account) {
  try { if (!await window.desktopAPI.removeAccount(account.id)) return } catch(e:any) { error.value=e?.message || t('账号移除未完成'); return }
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

const accountWrites = new AccountWrites()
const removeRestartPreparation = prepareBeforeRestart(async () => { await accountWrites.flush(); await googleVoice.flush() })
onUnmounted(removeRestartPreparation)
function mergeAccountFields(id: string, fields: Record<string, unknown>) {
  if (selected.value?.id === id) selected.value = { ...selected.value, ...fields }
  const index = accounts.value.findIndex(item => item.id === id)
  if (index >= 0) accounts.value[index] = { ...accounts.value[index], ...fields }
}
async function patchSelected(patch: Record<string, unknown>, isUndo = false) {
  patch = JSON.parse(JSON.stringify(patch))
  const account = selected.value
  if (!account) return
  const id = account.id
  const previous = Object.fromEntries(Object.keys(patch).map(key => [key, (account as any)[key] ?? null]))
  const currentFields = accountWrites.begin(id, patch)
  mergeAccountFields(id, patch)
  setFeedback('saving', t('正在保存…'))
  try {
    const updated = await accountWrites.enqueue(() => window.desktopAPI.updateAccount(id, patch))
    if (!updated) throw new Error(t('保存失败'))
    const fields = currentFields(updated)
    mergeAccountFields(id, fields)
    if (selected.value?.id === id && Object.keys(fields).length) { setFeedback('saved', t('仅此账号设置已保存')); if (!isUndo) undoChange.value = { id, patch: previous } }
  } catch (e: any) {
    // Read persisted state on failure; the optimistic previous value may itself have failed.
    try {
      const persisted = (await window.desktopAPI.listAccounts()).find((item: Account) => item.id === id)
      if (persisted) mergeAccountFields(id, currentFields(persisted))
    } catch { /* Leave the error visible if local storage cannot be read. */ }
    if (selected.value?.id === id && Object.keys(currentFields(patch)).length) setFeedback('error', e?.message || t('设置保存失败'))
  }
  await nextTick(); updateBounds()
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
  if (account && conversation?.id) {
    const current = accountWrites.begin(account.id, { [`contact:${conversation.id}`]: value })
    const isCurrent = () => Object.keys(current({})).length > 0
    setFeedback('saving', t('正在保存联系人语言…'))
    try {
      const updated: any = await accountWrites.enqueue(() => window.desktopAPI.setContactLanguage(account.id, conversation.id, value, conversation.name))
      if (updated && isCurrent()) {
        const stored = accounts.value.find(item => item.id === account.id)
        mergeAccountFields(account.id, { contactLanguages: { ...stored?.contactLanguages, [conversation.id]: updated.contactLanguages[conversation.id] } })
      }
      if (selected.value?.id === account.id && isCurrent()) setFeedback('saved', t('联系人语言已保存'))
    } catch (e: any) {
      if (selected.value?.id === account.id && isCurrent()) setFeedback('error', e?.message || t('联系人语言保存失败'))
    }
    return
  }
  await patchSelected({ targetLanguage: value })
}

async function undoAccountChange() { const undo = undoChange.value; if (!undo || selected.value?.id !== undo.id) return; await patchSelected(undo.patch, true); undoChange.value = null }
async function onNetworkRecovery() { invalidateProfile(); void refreshHealth(); try { await window.desktopAPI.recoverTranslations() } catch {} }
async function openSettings(tab: unknown = 'translation') {
  await window.desktopAPI.setOverlayOpen(true)
  settingsInitialTab.value = tab === 'updates' ? 'updates' : 'translation'
  showSettings.value = true
}

async function closeSettings() {
  collapsed.value = false
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
  // This authenticated renderer starts at Home. Clear the previous renderer's
  // native selection before resetting its modal latch, without closing sessions.
  try { await window.desktopAPI.focusPlatform({ platform: 'signal' }); await window.desktopAPI.setOverlayOpen(false) }
  catch { error.value = t('聊天显示状态未恢复，请重新打开窗口。') }
  if (disposed) return
  void googleVoice.listForHome()
  subscriptions.push(window.desktopAPI.onGoogleVoiceState(googleVoice.acceptState))
  void window.desktopAPI.noticesSnapshot().then((value:any)=>{if(!disposed)notices.value=value}).catch(()=>{})
  subscriptions.push(window.desktopAPI.onNoticesChanged((value:any)=>{notices.value=value}))
  subscriptions.push(window.desktopAPI.onOpenNotices(()=>{void openNotices()}))
  window.addEventListener('keydown', onShortcut)
  window.addEventListener('focus', invalidateProfile)
  window.addEventListener('online', onNetworkRecovery)
  window.addEventListener('offline', invalidateProfile)
  subscriptions.push(window.desktopAPI.onRuntimeChanged(() => { invalidateProfile(); void refreshHealth() }))
  subscriptions.push(window.desktopAPI.onShortcut((event:any) => onShortcut({ ...event, ctrlKey:true, preventDefault(){} } as KeyboardEvent)))
  void refreshHealth()
  subscriptions.push(window.desktopAPI.onBillingChanged(invalidateProfile))
  boundsObserver = new ResizeObserver(updateBounds)
  if (contentArea.value) boundsObserver.observe(contentArea.value)
  updateBounds()
  void measureRoutes()
  subscriptions.push(window.desktopAPI.onAccountUnread((event: any) => { unread.value[event.accountId] = Math.max(0, Number(event.count) || 0) }))
  void window.desktopAPI.getAccountUnread().then((value:Record<string,number>) => { unread.value = { ...value, ...unread.value } }).catch(() => {})
  subscriptions.push(window.desktopAPI.onAccountAction(async (event: any) => {
    if (['page-loading','page-ready','page-failed'].includes(event.action) && accounts.value.some(account => account.id === event.accountId)) {
      chatPageStates.value[event.accountId] = event.action === 'page-loading' ? 'loading' : event.action === 'page-ready' ? 'ready' : 'error'
      if (selected.value?.id === event.accountId) updateBounds()
      return
    }
    if (event.action === 'focus' && /^gv-[a-f0-9-]{36}$/.test(event.accountId || '')) { await googleVoice.focusNotification(event.accountId); return }
    const account = accounts.value.find(item => item.id === event.accountId)
    if (account && selected.value?.id === account.id && ['refreshing','refreshed','refresh-failed'].includes(event.action)) {
      clearTimeout(feedbackTimer)
      controlFeedback.value = {state:event.action==='refresh-failed'?'error':event.action==='refreshing'?'saving':'saved',message:event.action==='refresh-failed'?t('刷新未完成，草稿已保留。'):event.action==='refreshing'?t('正在刷新…'):t('已刷新，聊天和草稿已保留。')}
      if(event.action!=='refreshing')feedbackTimer=setTimeout(()=>{controlFeedback.value={state:'idle',message:''}},4000)
    }
    if (event.action === 'focus' && account) await select(account)
    if (event.action === 'configure' && account) await openSetup(account.platform, account)
    if (event.action === 'rename' && account) await renameAccount(account)
    if (event.action === 'updated') await reload()
    if (event.action === 'removed') { if (selected.value?.id === event.accountId) await home(); await reload() }
    if (event.action === 'home') await home()
    if (event.action === 'diagnose') await openSettings()
  }))
  healthTimer = setInterval(() => { void refreshHealth() }, 3000)
  walletTimer = setInterval(() => { void reloadProfile() }, 5000)
  subscriptions.push(window.desktopAPI.onWhatsAppConversation((info: any) => {
    if (!info?.accountId || !info?.conversationId) return
    conversations.value = { ...conversations.value, [info.accountId]: { id: info.conversationId, name: info.conversationName } }
  }))
  subscriptions.push(window.desktopAPI.onContactLanguage((event: any) => {
    const account = accounts.value.find(item => item.id === event.accountId)
    if (account && event.conversationId) mergeAccountFields(account.id, { contactLanguages: { ...account.contactLanguages, [event.conversationId]: { language: event.language, name: event.name, source: event.source, updatedAt: Date.now() } } })
  }))
  subscriptions.push(window.desktopAPI.onTranslatorStatus((status: any) => {
    if (!status?.accountId) return
    liveStatuses.value = {
      ...liveStatuses.value,
      [status.accountId]: {
        state: status.state || 'ready',
        message: status.message || t('翻译器就绪'),
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
  await Promise.allSettled([reload(), reloadSettings()])
})

onUnmounted(() => {
  disposed = true
  googleVoice.dispose()
  window.removeEventListener('keydown', onShortcut)
  window.removeEventListener('focus', invalidateProfile)
  window.removeEventListener('online', onNetworkRecovery); window.removeEventListener('offline', invalidateProfile)
  boundsObserver?.disconnect()
  cancelAnimationFrame(boundsFrame)
  subscriptions.forEach(unsubscribe => unsubscribe())
  if (healthTimer) clearInterval(healthTimer)
  if (walletTimer) clearInterval(walletTimer)
  if (feedbackTimer) clearTimeout(feedbackTimer)
})
</script>

<template>
  <div class="app-shell compact-shell" :class="{ 'sidebar-collapsed': collapsed }" :data-theme="settings?.workspaceTheme || 'charcoal'" :data-platform="googleVoiceActive ? 'google-voice' : selected?.platform || 'whatsapp'" :style="{gridTemplateColumns: (!googleVoiceActive && selected && navigationPosition === 'side' ? 244 : 88) + 'px minmax(0,1fr)'}">
    <aside class="sidebar compact-account-sidebar" :aria-label="t('账号与应用导航')">
      <nav class="platform-rail" :aria-label="t('应用种类')">
        <button class="brand compact-tool" @click="home" :title="t('HelloDog 工作台')" :aria-label="t('HelloDog 工作台')"><img src="/hellodog-icon.webp" alt="HelloDog" /><span class="rail-label">{{ t('主页') }}</span></button>
        <button v-for="platform in (['whatsapp','signal'] as const)" :key="platform" class="platform-entry compact-tool" :class="{active:!googleVoiceActive && selected && activePlatform === platform}" :title="platform === 'whatsapp' ? 'WhatsApp' : 'Signal'" :aria-label="(platform === 'whatsapp' ? 'WhatsApp' : 'Signal') + (platformUnread(platform) ? ' · ' + platformUnread(platform) + t(' 条未读') : '')" @click="choosePlatform(platform)" @contextmenu.prevent="platformMenu(platform)">
          <img :src="`./${platform}.svg`" alt="" /><span class="rail-label">{{ platform === 'whatsapp' ? 'WhatsApp' : 'Signal' }}</span><span v-if="platformUnread(platform)" class="unread-badge">{{ platformUnread(platform) > 99 ? '99+' : platformUnread(platform) }}</span>
        </button>
        <GoogleVoiceLauncher :active="googleVoiceActive" :unread="googleVoiceUnread" @select="googleVoice.enter" />
        <button class="compact-tool" @click="showAccountFinder" :title="t('搜索账号 (Ctrl+K)')" :aria-label="t('搜索账号')"><UiIcon name="search" /><span class="rail-label">{{ t('找窗口') }}</span></button>
        <div class="utility-spacer"></div>
        <template v-if="!collapsed">
          <button class="compact-tool" @click="openProfile" :title="t('个人中心 · 剩余 ') + remainingCharsLabel + t(' 字符')" :aria-label="t('个人中心与字符余额')"><UiIcon name="user" /><span class="rail-label">{{ t('我的账号') }}</span></button>
        </template>
        <button class="compact-tool" style="position:relative" @click="openNotices" :title="t('消息中心')" :aria-label="t('消息中心')"><UiIcon name="bell" /><span class="rail-label">{{ t('通知') }}</span><span v-if="notices.unread" class="unread-badge">{{notices.unread>99?'99+':notices.unread}}</span></button>
        <button class="compact-tool" @click="openSettings" :title="t('设置与连接诊断')" :aria-label="t('设置与连接诊断')"><UiIcon name="settings" /><span class="rail-label">{{ t('设置') }}</span></button>
        <button class="compact-tool" @click="openWebsite" :title="t('HelloDog 官网')" :aria-label="t('HelloDog 官网')"><UiIcon name="globe" /><span class="rail-label">{{ t('官网') }}</span></button>
        <button class="compact-tool" :disabled="restarting" @click="restartApp" :title="t('保存草稿并重启 HelloDog')" :aria-label="t('一键重启')"><UiIcon name="restart" /><span class="rail-label">{{ restarting ? t('重启中…') : t('重启') }}</span></button>
      </nav>
      <AccountNavigation v-if="!googleVoiceActive && selected && navigationPosition === 'side'" :accounts="platformAccounts" :ordering="orderingAccounts" @reorder="reorderAccounts" :selected-id="selected?.id" :unread="unread" :platform="activePlatform" position="side" @select="select" @menu="accountMenu" @add="openSetup(activePlatform)" @search="showAccountFinder" @remove="remove" @rename="renameAccount" />
    </aside>
    <TranslationQualityEditor v-if="showQuality && selected" :account="selected" :conversation="selectedConversation || undefined" @close="closeQuality" @updated="qualityUpdated" /><div v-if="finderOpen" class="compact-finder-backdrop" @click.self="closeAccountFinder" @keydown.esc.stop="closeAccountFinder">
      <section class="compact-finder" role="dialog" aria-modal="true" :aria-label="t('搜索和添加账号')">
        <header><b>{{ t('聊天账号') }}</b><button class="icon-button" @click="closeAccountFinder" :aria-label="t('关闭账号搜索')">×</button></header>
        <label class="account-search"><UiIcon name="search" /><input v-model="search" :placeholder="t('搜索账号')" :aria-label="t('搜索账号')" /></label>
        <div class="account-filters"><select v-model="platformFilter" :aria-label="t('平台筛选')"><option value="all">{{ t('全部平台') }}</option><option value="whatsapp">WhatsApp</option><option value="signal">Signal</option></select><select v-model="groupFilter" :aria-label="t('账号分组')"><option value="all">{{ t('全部分组') }}</option><option value="">{{ t('未分组') }}</option><option v-for="group in groups" :key="group">{{ group }}</option></select></div>
        <div class="finder-accounts"><button v-for="account in filteredAccounts" :key="account.id" @click="selectFromFinder(account)" @contextmenu.prevent="accountMenu(account)"><img :src="`./${account.platform}.svg`" alt="" /><span>{{ account.label }}<small>{{ accountSummary(account.id) }}</small></span></button><p v-if="!filteredAccounts.length">{{ t('没有匹配的账号。') }}</p></div>
        <footer><button @click="finderOpen = false; addWhatsApp()"><img :src="'./whatsapp.svg'" alt="" />{{ t('添加 WhatsApp') }}</button><button @click="finderOpen = false; addSignalRecord()"><img :src="'./signal.svg'" alt="" />{{ t('添加 Signal') }}</button></footer>
      </section>
    </div>
    <div class="workspace">
      <GoogleVoiceNavigation v-if="googleVoiceActive" :unread="unread" :windows="googleVoiceWindows" :selected-id="googleVoiceSelectedId" :busy="googleVoiceBusy" :loading="googleVoiceState === 'loading'" :can-go-back="googleVoice.canGoBack.value" :network="googleVoice.network.value" @select="googleVoice.focus($event.id)" @add="openGoogleVoiceWindowSetup()" @network="openGoogleVoiceWindowSetup(googleVoice.selected.value)" @rename="renameGoogleVoice" @close="googleVoice.close($event.id)" @reorder="googleVoice.reorder" @refresh="googleVoice.refresh" @back="googleVoice.back" @translation="openGoogleVoiceTranslation" />
      <div v-if="googleVoiceActive" class="voice-protection-status" role="status"><span v-if="googleVoiceMessage" class="voice-protection-copy" role="alert">{{ googleVoiceMessage }}</span><span v-else class="voice-protection-copy">{{ googleVoiceTranslationNotice }}</span><span class="quota-text" :class="{ low: quotaLow }" aria-live="polite" :title="quotaLow ? t('剩余字符不足 50,000，请及时补充；字符用完后无法发送翻译消息。') : undefined">{{ t('余 ') }}{{ remainingCharsLabel }}{{ t(' 字符') }}<b v-if="quotaLow">{{ t(' · 余额不足 50,000') }}</b></span></div>
      <AccountNavigation v-if="!googleVoiceActive && selected && navigationPosition === 'top'" :accounts="platformAccounts" :ordering="orderingAccounts" @reorder="reorderAccounts" :selected-id="selected?.id" :unread="unread" :platform="activePlatform" position="top" @select="select" @menu="accountMenu" @add="openSetup(activePlatform)" @search="showAccountFinder" @remove="remove" @rename="renameAccount"><template #tools><WorkspaceTools :selected="Boolean(selected)" :collapsed="selected?.toolbarCollapsed" :line="lineLabel" :offline="runtimeHealth?.online === false" @settings="openSettings" :refreshing="selected ? refreshingAccounts.has(selected.id) : false" @refresh="refreshCurrentChat" @toggle="selected && patchSelected({ toolbarCollapsed: !selected.toolbarCollapsed })" @menu="selected && accountMenu(selected)" /></template></AccountNavigation>
      <header v-if="!googleVoiceActive && selected && navigationPosition === 'side'" class="workspace-header compact-workspace-header"><h1>{{ selected?.label || t('你的聊天，世界都听得懂。') }}</h1><WorkspaceTools :selected="Boolean(selected)" :collapsed="selected?.toolbarCollapsed" :line="lineLabel" :offline="runtimeHealth?.online === false" @settings="openSettings" :refreshing="selected ? refreshingAccounts.has(selected.id) : false" @refresh="refreshCurrentChat" @toggle="selected && patchSelected({ toolbarCollapsed: !selected.toolbarCollapsed })" @menu="selected && accountMenu(selected)" /></header>
      <TranslationChannelSelector v-if="channelWindowId" :key="channelWindowId" :value="windowTranslationProvider" :channels="activeTranslationChannels" :loading="channelsLoading || googleVoiceBusy" :save="saveTranslationProvider" />
      <section v-if="!googleVoiceActive && selected" class="account-toolbar" :class="{ 'toolbar-compact': selected.toolbarCollapsed }" :inert="selected.toolbarCollapsed">
        <div class="language-control"><label><span>{{ t('我使用的语言') }}</span><select :value="localLanguage" @change="setStringField('localLanguage', $event)"><option v-for="language in languages.filter(x => x.code !== 'auto')" :key="language.code" :value="language.code">{{ languageName(language) }}</option></select></label><span class="language-arrow">⇄</span><label><span>{{ contactLabel || t('对方的语言') }}</span><select :value="targetLanguage" @change="setTargetLanguage"><option v-for="language in languages.filter(x => x.code !== 'auto')" :key="language.code" :value="language.code">{{ languageName(language) }}</option></select></label></div>
        <div class="translation-toggles"><label><input type="checkbox" :checked="receiveAutoTranslate" @change="patchSelected({ receiveAutoTranslate: !receiveAutoTranslate })" />{{ t('接收翻译') }}</label><label><input type="checkbox" :checked="sendAutoTranslate" @change="patchSelected({ sendAutoTranslate: !sendAutoTranslate })" />{{ t('发送翻译') }}</label><label><input type="checkbox" :checked="blockChineseSend" disabled :title="t('外语消息仍含中文时禁止发送，翻译失败保留草稿。')" />{{ t('拦截中文原文') }}</label><label><input type="checkbox" :checked="groupTranslate" @change="patchSelected({ groupTranslate: !groupTranslate })" />{{ t('群组翻译') }}</label></div>
        <button class="text-button" @click="openQuality" :title="t('设置当前账号或联系人的语气与术语')">{{ t('术语') }}</button><label class="tone-control">{{ t('语气') }}<select :value="selected.translationQuality?.tone || ''" @change="patchSelected({ translationQuality: { ...selected?.translationQuality, tone: ($event.target as HTMLSelectElement).value || undefined } })"><option value="">{{ t('跟随全局') }}</option><option value="natural">{{ t('自然') }}</option><option value="business">{{ t('商务') }}</option></select></label><label class="tone-control" :title="t('只影响当前账号；自动翻译未缓存的历史消息会按正常规则计费')">{{ t('历史') }}<select :value="selected.historyMode || ''" @change="patchSelected({ historyMode: ($event.target as HTMLSelectElement).value || undefined })"><option value="">{{ t('跟随全局') }}</option><option value="new">{{ t('新消息自动') }}</option><option value="visible">{{ t('可见消息自动') }}</option><option value="manual">{{ t('点击翻译') }}</option></select></label><div class="display-controls" role="group" :aria-label="t('译文显示')"><label>{{ t('译文字号') }}<select :value="fontSize" @change="setNumberField('fontSize', $event)"><option v-for="size in [12,13,14,15,16,18]" :key="size" :value="size">{{ size }} px</option></select></label><ConfirmColor :key="selected.id" :value="translationColor" :save="saveTranslationColor" /><button class="text-button" @click="patchSelected({ translationsVisible: selected.translationsVisible === false })">{{ selected.translationsVisible === false ? t('显示译文') : t('隐藏译文') }}</button></div>
      </section>
      <div v-if="!googleVoiceActive && selected" class="workspace-status"><div class="live-status" :class="selectedLiveStatus.state"><i></i><span>{{ uiError(selectedLiveStatus.message) }}</span></div><button v-if="selectedLiveStatus.state === 'error'" class="text-button" :disabled="refreshingAccounts.has(selected.id)" @click="refreshCurrentChat">{{ t('刷新重试') }}</button><button v-if="selected.proxy?.enabled" class="proxy-chip" @click="openSetup(selected.platform, selected)" :title="t('查看代理设置')">{{ t('独立代理已配置') }}</button><span class="save-feedback" :class="controlFeedback.state" role="status">{{ uiError(controlFeedback.message) }}</span><button v-if="undoChange?.id === selected.id" class="text-button" @click="undoAccountChange">{{ t('撤销修改') }}</button><span class="quota-text" :class="{ low: quotaLow }" role="status" aria-live="polite" :title="quotaLow ? t('剩余字符不足 50,000，请及时补充；字符用完后无法发送翻译消息。') : undefined">{{ t('余 ') }}{{ remainingCharsLabel }}{{ t(' 字符') }}<b v-if="quotaLow">{{ t(' · 余额不足 50,000') }}</b></span></div>
      <main ref="contentArea" class="content" :class="{ 'signal-content': !googleVoiceActive && selectedIsSignal }">
        <div v-if="selected?.runtimeMode === 'paused'" v-show="!googleVoiceActive" class="paused-account"><h2>{{ t('此账号已暂停') }}</h2><p>{{ t('恢复后继续收消息和查询原翻译任务。') }}</p><button class="primary" @click="resumeSelected">{{ t('恢复此窗口') }}</button></div>
        <SignalNativeView v-show="!googleVoiceActive" v-else-if="selectedIsSignal && selected?.signalEngine === 'desktop'" :key="'desktop-' + selected!.id" :account-record="selected!" @changed="reload" @conversation="info => { if (selected) conversations[selected.id] = info }" />
        <SignalView v-show="!googleVoiceActive" v-else-if="selectedIsSignal" :key="selected!.id" :account-record="selected!" :user-id="props.userId" @linked="reload" @conversation="info => { if (selected) conversations[selected.id] = info }" />
        <div v-else-if="selected?.platform === 'whatsapp' && chatPageStates[selected.id] !== 'ready'" v-show="!googleVoiceActive" class="chat-page-placeholder" :role="chatPageStates[selected.id] === 'error' ? 'alert' : 'status'">
          <UiIcon :name="chatPageStates[selected.id] === 'error' ? 'refresh' : 'chat'" /><h2>{{ chatPageStates[selected.id] === 'error' ? t('聊天页面未能显示') : t('正在打开聊天…') }}</h2>
          <p>{{ chatPageStates[selected.id] === 'error' ? t('账号和已保存的草稿仍保留，请刷新重试。') : t('正在连接 WhatsApp，可以继续切换其他窗口。') }}</p>
          <button class="secondary" :disabled="refreshingAccounts.has(selected.id)" @click="refreshCurrentChat">{{ refreshingAccounts.has(selected.id) ? t('正在刷新…') : t('刷新当前聊天') }}</button>
        </div>
        <div v-else-if="!selected" v-show="!googleVoiceActive" class="welcome app-home">
          <section class="app-center"><header><div><span class="eyebrow">HELLODOG</span><h2>{{ t('应用中心') }}</h2><p>{{ t('选择应用，创建聊天窗口') }}</p></div><span class="home-balance">{{ t('剩余 ') }}{{ remainingCharsLabel }}{{ t(' 字符') }}</span></header>
            <div class="platform-cards">
              <button @click="addWhatsApp"><img :src="'./whatsapp.svg'" alt="" /><b>WhatsApp</b><small>{{ accounts.filter(a => a.platform === 'whatsapp').length }}{{ t(' 个窗口') }}</small><span>{{ t('创建窗口') }} ＋</span></button>
              <button @click="addSignalRecord"><img :src="'./signal.svg'" alt="" /><b>Signal</b><small>{{ accounts.filter(a => a.platform === 'signal').length }}{{ t(' 个窗口') }}</small><span>{{ t('创建窗口') }} ＋</span></button>
              <button @click="openGoogleVoiceWindowSetup()"><img :src="'./google-voice.svg'" alt="" /><b>Google Voice</b><small>{{ googleVoiceWindows.length }}{{ t(' 个窗口') }}</small><span>{{ t('创建窗口') }} ＋</span></button>
            </div><p class="home-hint">{{ t('已有窗口可从左侧应用继续打开，顶部标签支持拖动排序。') }}</p>
          </section>
        </div>
        <GoogleVoiceContent v-if="googleVoiceActive" :state="googleVoiceState" :message="googleVoiceMessage" :has-windows="googleVoiceWindows.length > 0" :busy="googleVoiceBusy" @add="openGoogleVoiceWindowSetup()" @retry="googleVoice.retry" />
      </main>
    </div>
    <AccountSetup v-if="setup" :platform="setup.platform" :account="setup.account" :languages="languages" :owner="props.userId" @close="closeSetup" @saved="setupSaved" />
    <NotificationCenter v-if="showNotices" :snapshot="notices" @close="closeNotices" @updated="value => notices=value" />
    <SettingsPanel v-if="showSettings" :initial-tab="settingsInitialTab" @close="closeSettings" @updated="reloadSettings" />
    <PersonalCenter v-if="showProfile" @close="closeProfile" @updated="onProfileUpdated" />
    <GoogleVoiceTranslationSetup v-if="voiceTranslationTarget" :window-id="voiceTranslationTarget.id" :window-label="voiceTranslationTarget.label" :translation-notice="googleVoiceTranslationNotice" @close="closeGoogleVoiceTranslation" @settings="openGoogleVoiceSettings" />
    <GoogleVoiceWindowSetup v-if="voiceWindowSetup" :record="voiceWindowSetup.record" :network="voiceWindowSetup.record?.id === googleVoiceSelectedId ? googleVoice.network.value : undefined" :save="saveGoogleVoiceWindow" @close="closeGoogleVoiceWindowSetup" />
    <div v-if="renaming" class="modal-backdrop" @click.self="finishRename(false)"><form class="panel rename-panel" @submit.prevent="finishRename(true)"><header><h2>{{ t('给账号取个名字') }}</h2><button type="button" @click="finishRename(false)" :aria-label="t('关闭')">×</button></header><label>{{ t('账号名称') }}<input v-model="newLabel" maxlength="60" required autofocus /></label><footer><button type="button" class="secondary" @click="finishRename(false)">{{ t('取消') }}</button><button class="primary" type="submit">{{ t('保存名称') }}</button></footer></form></div>
    <div v-if="voiceRenaming" class="modal-backdrop" @click.self="finishGoogleVoiceRename(false)" @keydown.esc.stop="finishGoogleVoiceRename(false)"><form class="panel rename-panel" role="dialog" aria-modal="true" :aria-label="uiLanguage === 'en' ? 'Rename Google Voice window' : '重命名 Google Voice 窗口'" @submit.prevent="finishGoogleVoiceRename(true)"><header><h2>{{ uiLanguage === 'en' ? 'Rename window' : '重命名窗口' }}</h2><button type="button" :disabled="googleVoiceBusy" @click="finishGoogleVoiceRename(false)" :aria-label="t('关闭')">×</button></header><label>{{ uiLanguage === 'en' ? 'Window name' : '窗口名称' }}<input ref="voiceRenameInput" v-model="voiceNewLabel" maxlength="60" required :disabled="googleVoiceBusy" /></label><footer><button type="button" class="secondary" :disabled="googleVoiceBusy" @click="finishGoogleVoiceRename(false)">{{ t('取消') }}</button><button class="primary" type="submit" :disabled="googleVoiceBusy || !voiceNewLabel.trim()">{{ t('保存名称') }}</button></footer></form></div>
    <div v-if="error" class="toast" role="alert">{{ error }}<button @click="error = ''" :aria-label="t('关闭提示')">×</button></div>
  </div>
</template>

<style scoped>
.voice-protection-status { flex: 0 0 auto; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 16px; padding: 7px 12px; border-bottom: 1px solid var(--border); background: #2b241b; color: #e7c593; font-size: 11px; line-height: 1.5; }
.voice-protection-copy { flex: 1 1 520px; min-width: 0; overflow-wrap: anywhere; }
.voice-protection-status .quota-text { flex: 0 1 auto; max-width: 100%; margin-left: auto; white-space: normal; overflow-wrap: anywhere; }
</style>

<style scoped>
.chat-page-placeholder{display:flex;min-height:240px;height:100%;align-items:center;justify-content:center;flex-direction:column;gap:12px;padding:32px;color:var(--muted);text-align:center}.chat-page-placeholder h2{margin:0;font-size:20px;color:var(--text)}.chat-page-placeholder p{margin:0;line-height:1.7}.chat-page-placeholder>svg{width:34px;height:34px}.compact-tool:disabled{opacity:.55;cursor:wait}
</style>
