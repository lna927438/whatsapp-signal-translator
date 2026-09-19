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
import AccountNavigation from './components/AccountNavigation.vue'
import WorkspaceTools from './components/WorkspaceTools.vue'
import NotificationCenter from './components/NotificationCenter.vue'
import TranslationQualityEditor from './components/TranslationQualityEditor.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import PersonalCenter from './components/PersonalCenter.vue'
import ReliabilityPanel from './components/ReliabilityPanel.vue'
import SignalView from './components/SignalView.vue'
import SignalNativeView from './components/SignalNativeView.vue'
import { cloudApi } from './lib/cloudApi'
import { AccountWrites } from './lib/accountWrites'
import { RemoteSnapshot } from './lib/remoteSnapshot'
import { prepareBeforeRestart } from './lib/restartState'
import { orderedAccounts } from '../../shared/accountOrder'
import { useGoogleVoiceWorkspace, type GoogleVoiceWindow } from './lib/googleVoiceWorkspace'

const props = defineProps<{ userId: string }>()

type ContactPreference = { language?: string; translationQuality?: any; name?: string; updatedAt: number; source?: 'manual'|'auto' }
type Account = {
  id: string
  platform: 'whatsapp'|'signal'
  label: string
  note?: string
  caption?: string
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
const showReliability = ref(false), reliabilityTab = ref('history'), runtimeHealth = ref<any>(null)
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
const collapsed = ref(localStorage.getItem('hellodog:sidebar-collapsed') === 'true')
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
const { active: googleVoiceActive, windows: googleVoiceWindows, selectedId: googleVoiceSelectedId, state: googleVoiceState, message: googleVoiceMessage, busy: googleVoiceBusy } = googleVoice
const translationHistoryAccounts = computed(() => [...accounts.value, ...googleVoiceWindows.value])
const voiceRenaming = ref<GoogleVoiceWindow | null>(null), voiceNewLabel = ref(''), voiceRenameInput = ref<HTMLInputElement>()
const voiceTranslationTarget = ref<GoogleVoiceWindow | null>(null)
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
const filteredAccounts = computed(() => accounts.value.filter(item => (item.label+' '+(item.note||'')+' '+(item.caption||'')).toLowerCase().includes(search.value.toLowerCase()) && (platformFilter.value === 'all' || item.platform === platformFilter.value) && (groupFilter.value === 'all' || (item.group || '') === groupFilter.value)).sort((a,b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))))

const renaming = ref<Account | null>(null)
const newLabel = ref('')
const editingRemark = ref(false)
const editingCaption = ref(false)
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
watch(collapsed, async value => { localStorage.setItem('hellodog:sidebar-collapsed', String(value)); await nextTick(); updateBounds() })
async function home() {
  googleVoice.leave()
  selected.value = null
  await window.desktopAPI.focusPlatform({ platform: 'signal' })
}
function accountMenu(account: Account) { void window.desktopAPI.showAccountMenu(account.id) }
async function renameAccount(account: Account, remark = false, caption = false) {
  await window.desktopAPI.setOverlayOpen(true)
  renaming.value = account; editingRemark.value = remark; editingCaption.value = caption; newLabel.value = caption ? account.caption || '' : remark ? account.note || '' : account.label
}
async function finishRename(save: boolean) {
  if (save && renaming.value) {
    const label = newLabel.value.trim().slice(0, editingCaption.value ? 120 : editingRemark.value ? 80 : 60)
    if (!label && !editingRemark.value) return
    try { await window.desktopAPI.updateAccount(renaming.value.id, editingCaption.value ? { caption: label } : editingRemark.value ? { note: label } : { label }); await reload() }
    catch (e: any) { error.value = e?.message || t('名称保存失败'); return }
  }
  renaming.value = null
  await window.desktopAPI.setOverlayOpen(false)
}
function onShortcut(event: KeyboardEvent) {
  if (event.key === 'F5' || (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') {
    event.preventDefault()
    if (googleVoiceActive.value) { void googleVoice.refresh(); return }
    if (selected.value) void window.desktopAPI.refreshAccount(selected.value.id).catch((e: any) => { error.value = e?.message || t('刷新未完成，草稿已保留。') })
    return
  }
  if ((event.ctrlKey || event.metaKey) && ((event.shiftKey && event.key.toLowerCase() === 'f') || event.key.toLowerCase() === 'k')) { event.preventDefault(); void showAccountFinder(); }
  if ((event.ctrlKey || event.metaKey) && event.key === '/') { event.preventDefault(); void openReliability('help'); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') { event.preventDefault(); collapsed.value = !collapsed.value }
  if (event.key === 'Escape') {
    if (voiceTranslationTarget.value) { void closeGoogleVoiceTranslation(); return }
    if (voiceRenaming.value) { void finishGoogleVoiceRename(false); return }
    if (showNotices.value) { void closeNotices(); return }
    if (showQuality.value) { void closeQuality(); return }
    if (showReliability.value) void closeReliability()
    else if (finderOpen.value) void closeAccountFinder()
    else if (renaming.value) void finishRename(false)
    else if (showSettings.value) void closeSettings()
    else if (showProfile.value) void closeProfile()
  }
}

const settings = ref<any>(null)
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
const apiConfigured = computed(() => {
  const provider = settings.value?.provider
  if (provider === 'openai') return true
  if (provider === 'deepl') return Boolean(String(settings.value?.deeplApiKey || '').trim())
  if (provider === 'google') return Boolean(String(settings.value?.googleApiKey || '').trim())
  return false
})
const selectedLiveStatus = computed<LiveStatus>(() => {
  if (!apiConfigured.value) return { state: 'error', message: t('翻译服务未配置') }
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
  const started = performance.now()
  googleVoice.leave()
  selected.value = account
  activePlatform.value = account.platform
  lastAccounts.set(account.platform, account.id)
  await nextTick()
  updateBounds()
  controlFeedback.value = { state: 'idle', message: '' }
  try { await window.desktopAPI.focusPlatform({ platform: account.platform, accountId: account.id }); await window.desktopAPI.recordSwitchDuration(performance.now() - started) }
  catch (e: any) { if (selected.value?.id === account.id) error.value = e?.message || t('页面加载失败，请重新打开此账号。') }
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

async function openReliability(tab = 'history') { await window.desktopAPI.setOverlayOpen(true); reliabilityTab.value = tab; showReliability.value = true }
async function closeReliability() { showReliability.value = false; await window.desktopAPI.setOverlayOpen(false); await reload(); void refreshHealth() }
async function undoAccountChange() { const undo = undoChange.value; if (!undo || selected.value?.id !== undo.id) return; await patchSelected(undo.patch, true); undoChange.value = null }
async function onNetworkRecovery() { invalidateProfile(); void refreshHealth(); try { await window.desktopAPI.recoverTranslations() } catch {} }
async function openSettings() {
  await window.desktopAPI.setOverlayOpen(true)
  showSettings.value = true
}

async function closeSettings() {
  collapsed.value = localStorage.getItem('hellodog:sidebar-collapsed') === 'true'
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
    const account = accounts.value.find(item => item.id === event.accountId)
    if (account && selected.value?.id === account.id && ['refreshing','refreshed','refresh-failed'].includes(event.action)) {
      clearTimeout(feedbackTimer)
      controlFeedback.value = {state:event.action==='refresh-failed'?'error':event.action==='refreshing'?'saving':'saved',message:event.action==='refresh-failed'?t('刷新未完成，草稿已保留。'):event.action==='refreshing'?t('正在刷新…'):t('已刷新，聊天和草稿已保留。')}
      if(event.action!=='refreshing')feedbackTimer=setTimeout(()=>{controlFeedback.value={state:'idle',message:''}},4000)
    }
    if (event.action === 'focus' && account) await select(account)
    if (event.action === 'configure' && account) await openSetup(account.platform, account)
    if (event.action === 'rename' && account) await renameAccount(account)
    if (event.action === 'remark' && account) await renameAccount(account, true)
    if (event.action === 'caption' && account) await renameAccount(account, true, true)
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
  <div class="app-shell compact-shell" :class="{ 'sidebar-collapsed': collapsed }" :data-theme="settings?.workspaceTheme || 'charcoal'" :data-platform="googleVoiceActive ? 'google-voice' : selected?.platform || 'whatsapp'" :style="{gridTemplateColumns: (!googleVoiceActive && navigationPosition === 'side' ? 208 : 52) + 'px minmax(0,1fr)'}">
    <aside class="sidebar compact-account-sidebar" :aria-label="t('账号与应用导航')">
      <nav class="platform-rail" :aria-label="t('应用种类')">
        <button class="brand compact-tool" @click="home" :title="t('HelloDog 工作台')" :aria-label="t('HelloDog 工作台')"><img src="/hellodog-icon.webp" alt="HelloDog" /></button>
        <button v-for="platform in (['whatsapp','signal'] as const)" :key="platform" class="platform-entry compact-tool" :class="{active:!googleVoiceActive && selected && activePlatform === platform}" :title="platform === 'whatsapp' ? 'WhatsApp' : 'Signal'" :aria-label="(platform === 'whatsapp' ? 'WhatsApp' : 'Signal') + (platformUnread(platform) ? ' · ' + platformUnread(platform) + t(' 条未读') : '')" @click="choosePlatform(platform)" @contextmenu.prevent="platformMenu(platform)">
          <img :src="`./${platform}.svg`" alt="" /><span v-if="platformUnread(platform)" class="unread-badge">{{ platformUnread(platform) > 99 ? '99+' : platformUnread(platform) }}</span>
        </button>
        <GoogleVoiceLauncher :active="googleVoiceActive" @select="googleVoice.enter" />
        <button class="compact-tool" @click="showAccountFinder" :title="t('搜索账号 (Ctrl+K)')" :aria-label="t('搜索账号')"><UiIcon name="search" /></button>
        <div class="utility-spacer"></div>
        <template v-if="!collapsed">
          <button class="compact-tool" @click="openProfile" :title="t('个人中心 · 剩余 ') + remainingCharsLabel + t(' 字符')" :aria-label="t('个人中心与字符余额')"><UiIcon name="user" /></button>
          <button class="compact-tool" @click="openReliability()" :title="t('翻译记录与恢复')" :aria-label="t('翻译记录与恢复')"><UiIcon name="shield" /></button>
          <button class="compact-tool" :disabled="restarting" :aria-busy="restarting" @click="restartApp" :title="restarting ? t('正在保存并重启…') : t('重启软件')" :aria-label="t('重启软件')"><UiIcon name="restart" /></button>
        </template>
        <button class="compact-tool" style="position:relative" @click="openNotices" :title="t('消息中心')" :aria-label="t('消息中心')"><UiIcon name="bell" /><span v-if="notices.unread" class="unread-badge">{{notices.unread>99?'99+':notices.unread}}</span></button>
        <button class="compact-tool" @click="openWebsite" :title="t('官网与最新版本')" :aria-label="t('官网与最新版本')"><UiIcon name="globe" /></button>
        <button class="compact-tool" @click="openSettings" :title="t('设置与连接诊断')" :aria-label="t('设置与连接诊断')"><UiIcon name="settings" /></button>
        <button class="compact-tool" :aria-expanded="!collapsed" :title="t('切换功能栏')" :aria-label="t('切换功能栏')" @click="collapsed = !collapsed"><UiIcon name="more" /></button>
      </nav>
      <AccountNavigation v-if="!googleVoiceActive && navigationPosition === 'side'" :accounts="platformAccounts" :ordering="orderingAccounts" @reorder="reorderAccounts" :selected-id="selected?.id" :unread="unread" :platform="activePlatform" position="side" @select="select" @menu="accountMenu" @add="openSetup(activePlatform)" @search="showAccountFinder" @remove="remove" @remark="account => renameAccount(account,true)" @caption="account => renameAccount(account,true,true)" />
    </aside>
    <TranslationQualityEditor v-if="showQuality && selected" :account="selected" :conversation="selectedConversation || undefined" @close="closeQuality" @updated="qualityUpdated" /><div v-if="finderOpen" class="compact-finder-backdrop" @click.self="closeAccountFinder" @keydown.esc.stop="closeAccountFinder">
      <section class="compact-finder" role="dialog" aria-modal="true" :aria-label="t('搜索和添加账号')">
        <header><b>{{ t('聊天账号') }}</b><button class="icon-button" @click="closeAccountFinder" :aria-label="t('关闭账号搜索')">×</button></header>
        <label class="account-search"><UiIcon name="search" /><input v-model="search" :placeholder="t('搜索账号')" :aria-label="t('搜索账号')" /></label>
        <div class="account-filters"><select v-model="platformFilter" :aria-label="t('平台筛选')"><option value="all">{{ t('全部平台') }}</option><option value="whatsapp">WhatsApp</option><option value="signal">Signal</option></select><select v-model="groupFilter" :aria-label="t('账号分组')"><option value="all">{{ t('全部分组') }}</option><option value="">{{ t('未分组') }}</option><option v-for="group in groups" :key="group">{{ group }}</option></select></div>
        <div class="finder-accounts"><button v-for="account in filteredAccounts" :key="account.id" @click="selectFromFinder(account)" @contextmenu.prevent="accountMenu(account)"><img :src="`./${account.platform}.svg`" alt="" /><span>{{ account.note || account.label }}<small>{{ accountSummary(account.id) }}</small></span></button><p v-if="!filteredAccounts.length">{{ t('没有匹配的账号。') }}</p></div>
        <footer><button @click="finderOpen = false; addWhatsApp()"><img :src="'./whatsapp.svg'" alt="" />{{ t('添加 WhatsApp') }}</button><button @click="finderOpen = false; addSignalRecord()"><img :src="'./signal.svg'" alt="" />{{ t('添加 Signal') }}</button></footer>
      </section>
    </div>
    <div class="workspace">
      <GoogleVoiceNavigation v-if="googleVoiceActive" :windows="googleVoiceWindows" :selected-id="googleVoiceSelectedId" :busy="googleVoiceBusy" :loading="googleVoiceState === 'loading'" :can-go-back="googleVoice.canGoBack.value" @select="googleVoice.focus($event.id)" @add="googleVoice.add" @rename="renameGoogleVoice" @close="googleVoice.close($event.id)" @reorder="googleVoice.reorder" @refresh="googleVoice.refresh" @back="googleVoice.back" @translation="openGoogleVoiceTranslation" />
      <div v-if="googleVoiceActive" class="voice-protection-status" role="status"><span v-if="googleVoiceMessage" class="voice-protection-copy" role="alert">{{ googleVoiceMessage }}</span><span v-else class="voice-protection-copy">{{ uiLanguage === 'en' ? 'Text translation is built in. Preview before sending; check any unconfirmed send in the conversation.' : '已内置短信翻译 · 发送前先预览，发送结果不明时先核对会话。' }}</span><span class="quota-text" :class="{ low: quotaLow }" aria-live="polite" :title="quotaLow ? t('剩余字符不足 50,000，请及时补充；字符用完后无法发送翻译消息。') : undefined">{{ t('余 ') }}{{ remainingCharsLabel }}{{ t(' 字符') }}<b v-if="quotaLow">{{ t(' · 余额不足 50,000') }}</b></span></div>
      <AccountNavigation v-if="!googleVoiceActive && navigationPosition === 'top'" :accounts="platformAccounts" :ordering="orderingAccounts" @reorder="reorderAccounts" :selected-id="selected?.id" :unread="unread" :platform="activePlatform" position="top" @select="select" @menu="accountMenu" @add="openSetup(activePlatform)" @search="showAccountFinder" @remove="remove" @remark="account => renameAccount(account,true)" @caption="account => renameAccount(account,true,true)"><template #tools><WorkspaceTools :selected="Boolean(selected)" :collapsed="selected?.toolbarCollapsed" :line="lineLabel" :offline="runtimeHealth?.online === false" @settings="openSettings" @help="openReliability('help')" @toggle="selected && patchSelected({ toolbarCollapsed: !selected.toolbarCollapsed })" @menu="selected && accountMenu(selected)" /></template></AccountNavigation>
      <header v-if="!googleVoiceActive && (navigationPosition === 'side' || !selected)" class="workspace-header compact-workspace-header"><h1>{{ selected?.note || selected?.label || t('你的聊天，世界都听得懂。') }}</h1><WorkspaceTools :selected="Boolean(selected)" :collapsed="selected?.toolbarCollapsed" :line="lineLabel" :offline="runtimeHealth?.online === false" @settings="openSettings" @help="openReliability('help')" @toggle="selected && patchSelected({ toolbarCollapsed: !selected.toolbarCollapsed })" @menu="selected && accountMenu(selected)" /></header>
      <section v-if="!googleVoiceActive && selected" class="account-toolbar" :class="{ 'toolbar-compact': selected.toolbarCollapsed }" :inert="selected.toolbarCollapsed">
        <div class="language-control"><label><span>{{ t('我使用的语言') }}</span><select :value="localLanguage" @change="setStringField('localLanguage', $event)"><option v-for="language in languages.filter(x => x.code !== 'auto')" :key="language.code" :value="language.code">{{ languageName(language) }}</option></select></label><span class="language-arrow">⇄</span><label><span>{{ contactLabel || t('对方的语言') }}</span><select :value="targetLanguage" @change="setTargetLanguage"><option v-for="language in languages.filter(x => x.code !== 'auto')" :key="language.code" :value="language.code">{{ languageName(language) }}</option></select></label></div>
        <div class="translation-toggles"><label><input type="checkbox" :checked="receiveAutoTranslate" @change="patchSelected({ receiveAutoTranslate: !receiveAutoTranslate })" />{{ t('接收翻译') }}</label><label><input type="checkbox" :checked="sendAutoTranslate" @change="patchSelected({ sendAutoTranslate: !sendAutoTranslate })" />{{ t('发送翻译') }}</label><label><input type="checkbox" :checked="blockChineseSend" disabled :title="t('外语消息仍含中文时禁止发送，翻译失败保留草稿。')" />{{ t('拦截中文原文') }}</label><label><input type="checkbox" :checked="groupTranslate" @change="patchSelected({ groupTranslate: !groupTranslate })" />{{ t('群组翻译') }}</label></div>
        <button class="text-button" @click="openQuality" :title="t('设置当前账号或联系人的语气与术语')">{{ t('术语') }}</button><label class="tone-control">{{ t('语气') }}<select :value="selected.translationQuality?.tone || ''" @change="patchSelected({ translationQuality: { ...selected?.translationQuality, tone: ($event.target as HTMLSelectElement).value || undefined } })"><option value="">{{ t('跟随全局') }}</option><option value="natural">{{ t('自然') }}</option><option value="business">{{ t('商务') }}</option></select></label><label class="tone-control" :title="t('只影响当前账号；自动翻译未缓存的历史消息会按正常规则计费')">{{ t('历史') }}<select :value="selected.historyMode || ''" @change="patchSelected({ historyMode: ($event.target as HTMLSelectElement).value || undefined })"><option value="">{{ t('跟随全局') }}</option><option value="new">{{ t('新消息自动') }}</option><option value="visible">{{ t('可见消息自动') }}</option><option value="manual">{{ t('点击翻译') }}</option></select></label><div class="display-controls" role="group" :aria-label="t('译文显示')"><label>{{ t('译文字号') }}<select :value="fontSize" @change="setNumberField('fontSize', $event)"><option v-for="size in [12,13,14,15,16,18]" :key="size" :value="size">{{ size }} px</option></select></label><label :title="t('译文颜色')">{{ t('颜色') }}<input type="color" :value="translationColor" @change="setStringField('translationColor', $event)" /></label><button class="text-button" @click="patchSelected({ translationsVisible: selected.translationsVisible === false })">{{ selected.translationsVisible === false ? t('显示译文') : t('隐藏译文') }}</button></div>
      </section>
      <div v-if="!googleVoiceActive && selected" class="workspace-status"><div class="live-status" :class="selectedLiveStatus.state"><i></i><span>{{ uiError(selectedLiveStatus.message) }}</span></div><button v-if="selectedLiveStatus.state === 'error'" class="text-button" @click="openReliability('history')">{{ t('翻译恢复') }}</button><button v-if="runtimeHealth?.pendingSends?.some((task:any) => task.accountId === selected?.id)" class="text-button" @click="openReliability('runtime')">{{ t('处理未发送消息') }}</button><button v-if="selected.proxy?.enabled" class="proxy-chip" @click="openSetup(selected.platform, selected)" :title="t('查看代理设置')">{{ t('独立代理已配置') }}</button><span class="save-feedback" :class="controlFeedback.state" role="status">{{ uiError(controlFeedback.message) }}</span><button v-if="undoChange?.id === selected.id" class="text-button" @click="undoAccountChange">{{ t('撤销修改') }}</button><span class="quota-text" :class="{ low: quotaLow }" role="status" aria-live="polite" :title="quotaLow ? t('剩余字符不足 50,000，请及时补充；字符用完后无法发送翻译消息。') : undefined">{{ t('余 ') }}{{ remainingCharsLabel }}{{ t(' 字符') }}<b v-if="quotaLow">{{ t(' · 余额不足 50,000') }}</b></span></div>
      <main ref="contentArea" class="content" :class="{ 'signal-content': !googleVoiceActive && selectedIsSignal }">
        <div v-if="selected?.runtimeMode === 'paused'" v-show="!googleVoiceActive" class="paused-account"><h2>{{ t('此账号已暂停') }}</h2><p>{{ t('恢复后继续收消息和查询原翻译任务。') }}</p><button class="primary" @click="openReliability('runtime')">{{ t('管理账号运行') }}</button></div>
        <SignalNativeView v-show="!googleVoiceActive" v-else-if="selectedIsSignal && selected?.signalEngine === 'desktop'" :key="'desktop-' + selected!.id" :account-record="selected!" @changed="reload" @conversation="info => { if (selected) conversations[selected.id] = info }" />
        <SignalView v-show="!googleVoiceActive" v-else-if="selectedIsSignal" :key="selected!.id" :account-record="selected!" :user-id="props.userId" @linked="reload" @conversation="info => { if (selected) conversations[selected.id] = info }" />
        <div v-else-if="!selected" v-show="!googleVoiceActive" class="welcome"><section class="app-center"><h2>{{ t('应用中心') }}</h2><div class="platform-cards"><button @click="addWhatsApp"><img :src="'./whatsapp.svg'" alt="" />WhatsApp<small>{{ accounts.filter(a => a.platform === 'whatsapp').length }}{{ t(' 个账号 · 添加窗口') }}</small></button><button @click="addSignalRecord"><img :src="'./signal.svg'" alt="" />Signal<small>{{ accounts.filter(a => a.platform === 'signal').length }}{{ t(' 个账号 · 添加窗口') }}</small></button></div></section>
          <div class="welcome-copy"><span class="eyebrow">SAY HELLO, GO FURTHER.</span><h2>{{ t('让交流少一点距离。') }}<br /><em>{{ t('多一点 Hello。') }}</em></h2><p>{{ t('连接你的聊天账号，用熟悉的语言，聊更远的世界。') }}</p><div class="welcome-actions"><button class="primary" @click="addWhatsApp"><UiIcon name="plus" />{{ t('添加 WhatsApp') }}</button><button class="secondary" @click="addSignalRecord()">{{ t('添加 Signal') }}</button></div><small>{{ t('已有账号？从左侧选择，继续上一次对话。') }}</small></div><img class="welcome-dog" src="/hellodog-icon.webp" :alt="t('HelloDog 小狗')" />
          <div class="welcome-cards"><button @click="openSettings"><UiIcon name="signal" /><b>{{ t('先检查连接') }}</b><p>{{ t('检测线路、登录与翻译服务，定位问题。') }}</p><span>{{ t('打开连接诊断 →') }}</span></button><button @click="openProfile"><UiIcon name="user" /><b>{{ t('字符余额，一目了然') }}</b><p>{{ t('剩余 ') }}{{ remainingCharsLabel }}{{ t(' 字符，查看真实消费记录。') }}</p><span>{{ t('打开个人中心 →') }}</span></button><article><UiIcon name="shield" /><b>{{ t('恢复中断的消息') }}</b><p>{{ t('失败保留草稿，发送结果不明确时由你确认。') }}</p><span>{{ t('账号右键 · 更多实用操作') }}</span></article></div>
        </div>
        <GoogleVoiceContent v-if="googleVoiceActive" :state="googleVoiceState" :message="googleVoiceMessage" :has-windows="googleVoiceWindows.length > 0" :busy="googleVoiceBusy" @add="googleVoice.add" @retry="googleVoice.retry" />
      </main>
    </div>
    <AccountSetup v-if="setup" :platform="setup.platform" :account="setup.account" :languages="languages" :owner="props.userId" @close="closeSetup" @saved="setupSaved" />
    <NotificationCenter v-if="showNotices" :snapshot="notices" @close="closeNotices" @updated="value => notices=value" />
    <SettingsPanel v-if="showSettings" @close="closeSettings" @updated="reloadSettings" />
    <ReliabilityPanel v-if="showReliability" :accounts="accounts" :selected-id="googleVoiceActive ? undefined : selected?.id" :history-accounts="translationHistoryAccounts" :history-selected-id="googleVoiceActive ? googleVoiceSelectedId : selected?.id" :initial-tab="reliabilityTab" @close="closeReliability" @updated="reload" />
    <PersonalCenter v-if="showProfile" @close="closeProfile" @updated="onProfileUpdated" />
    <GoogleVoiceTranslationSetup v-if="voiceTranslationTarget" :window-id="voiceTranslationTarget.id" :window-label="voiceTranslationTarget.label" @close="closeGoogleVoiceTranslation" @settings="openGoogleVoiceSettings" />
    <div v-if="renaming" class="modal-backdrop" @click.self="finishRename(false)"><form class="panel rename-panel" @submit.prevent="finishRename(true)"><header><h2>{{ editingCaption ? t('编辑红色备注') : editingRemark ? t('编辑备注') : t('给账号取个名字') }}</h2><button type="button" @click="finishRename(false)" :aria-label="t('关闭')">×</button></header><label>{{ editingCaption ? t('独立红色备注') : editingRemark ? t('账号备注') : t('账号名称') }}<input v-model="newLabel" :maxlength="editingCaption ? 120 : editingRemark ? 80 : 60" :required="!editingRemark" autofocus /></label><footer><button type="button" class="secondary" @click="finishRename(false)">{{ t('取消') }}</button><button class="primary" type="submit">{{ editingRemark ? t('保存备注') : t('保存名称') }}</button></footer></form></div>
    <div v-if="voiceRenaming" class="modal-backdrop" @click.self="finishGoogleVoiceRename(false)" @keydown.esc.stop="finishGoogleVoiceRename(false)"><form class="panel rename-panel" role="dialog" aria-modal="true" :aria-label="uiLanguage === 'en' ? 'Rename Google Voice window' : '重命名 Google Voice 窗口'" @submit.prevent="finishGoogleVoiceRename(true)"><header><h2>{{ uiLanguage === 'en' ? 'Rename window' : '重命名窗口' }}</h2><button type="button" :disabled="googleVoiceBusy" @click="finishGoogleVoiceRename(false)" :aria-label="t('关闭')">×</button></header><label>{{ uiLanguage === 'en' ? 'Window name' : '窗口名称' }}<input ref="voiceRenameInput" v-model="voiceNewLabel" maxlength="60" required :disabled="googleVoiceBusy" /></label><footer><button type="button" class="secondary" :disabled="googleVoiceBusy" @click="finishGoogleVoiceRename(false)">{{ t('取消') }}</button><button class="primary" type="submit" :disabled="googleVoiceBusy || !voiceNewLabel.trim()">{{ t('保存名称') }}</button></footer></form></div>
    <div v-if="error" class="toast" role="alert">{{ error }}<button @click="error = ''" :aria-label="t('关闭提示')">×</button></div>
  </div>
</template>

<style scoped>
.voice-protection-status { flex: 0 0 auto; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 16px; padding: 7px 12px; border-bottom: 1px solid var(--border); background: #2b241b; color: #e7c593; font-size: 11px; line-height: 1.5; }
.voice-protection-copy { flex: 1 1 520px; min-width: 0; overflow-wrap: anywhere; }
.voice-protection-status .quota-text { flex: 0 1 auto; max-width: 100%; margin-left: auto; white-space: normal; overflow-wrap: anywhere; }
</style>
