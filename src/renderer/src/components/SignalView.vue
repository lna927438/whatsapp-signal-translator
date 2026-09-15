<script setup lang="ts">
import { t, uiLanguage, languageName, uiError } from '../lib/uiLocale'

import QRCode from 'qrcode'
import { SignalTypingState, type SignalTyping } from '../../../shared/signalTyping'
import { normalizeSignalPeer, type SignalContact } from '../../../shared/signalProtocol'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { readDraft, saveDraft, upsertMessage, type DraftScope } from '../lib/signalState'
import SignalSettings from './SignalSettings.vue'
import SignalDetails from './SignalDetails.vue'
import SignalMedia from './SignalMedia.vue'
import SignalComposerTools from './SignalComposerTools.vue'
import { mediaIntent, signalMediaEntries, type SignalAttachment } from '../../../shared/signalMedia'
import { signalPreferenceDefaults, type SignalPreferences, type SignalConversationPreference } from '../../../shared/signalPreferences'
import { prepareBeforeRestart } from '../lib/restartState'

const props = defineProps<{ accountRecord: any; userId: string }>()
const signalIcon = './signal.svg'
const typingState = new SignalTypingState(), typingUsers = ref<SignalTyping[]>([])
let offTyping: undefined | (() => void)
const typingHere = computed(() => typingUsers.value.some(value => value.account === activeAccount.value && [recipient.value,...(activeContact.value?.aliases || [])].includes(value.peer)))
function acceptTyping(value:SignalTyping) { if (value.account !== activeAccount.value) return; typingState.update(value); typingUsers.value=typingState.snapshot() }

const emit = defineEmits(['linked', 'conversation'])
const signalAccounts = ref<string[]>([])
const activeAccount = ref(props.accountRecord.signalAccount || '')
const peerKey = 'translator-signal-peer:' + JSON.stringify([props.userId, props.accountRecord.id])
const recipient = ref(localStorage.getItem(peerKey) || '')
const scope = (): DraftScope => ({ userId: props.userId, recordId: props.accountRecord.id, account: activeAccount.value, peer: recipient.value.trim() })
const input = ref(readDraft(localStorage, scope()))
const mediaTools = ref<InstanceType<typeof SignalComposerTools>>()
const mediaDraft = ref<SignalAttachment[]>([]), mediaBusy = ref(false)
const removeRestartPreparation = prepareBeforeRestart(async () => {
  if (mediaBusy.value) throw new Error(t('请先结束录音或等待附件准备完成，再重启。'))
  if (recipient.value.trim()) await window.desktopAPI.saveDraft(mainDraftTarget(), input.value)
})
onUnmounted(removeRestartPreparation)
function pasteMedia(event: ClipboardEvent) { const files = Array.from(event.clipboardData?.files || []); if (files.length) { event.preventDefault(); void mediaTools.value?.acceptFiles(files) } }
function dropMedia(event: DragEvent) { const files = Array.from(event.dataTransfer?.files || []); if (files.length) { event.preventDefault(); void mediaTools.value?.acceptFiles(files) } }
const messages = ref<any[]>([])
const linkUri = ref('')
const qr = ref('')
const status = ref('')
const diagnostic = ref('')
const desktopAvailable = ref(false)
async function openDesktop(){try{await window.desktopAPI.signalDesktopOpen(props.accountRecord.id);emit('linked')}catch(e:any){status.value=e.message}}
const linking = ref(false)
const sending = ref(false)
const preferences = ref<SignalPreferences>(structuredClone(signalPreferenceDefaults))
const settingsOpen = ref(false), detailsOpen = ref(false), chatMenuOpen = ref(false), showArchived = ref(false), activeFolder = ref('')
const messageSearch = ref(''), searchOpen = ref(false), avatars = ref<Record<string,string>>({})
const folderEditor = ref<any>(null), folderName = ref(''), folderPeers = ref<string[]>([]), groupEditor = ref(false), groupName = ref(''), groupMembers = ref<string[]>([]), groupBusy = ref(false)
const outbox = ref<any[]>([])
let workQueue: Promise<any> = Promise.resolve(), offChanged: undefined | (() => void)
const readyTranslations = new Map<string, Promise<any>>()
function prepareTranslation(task:any) {
  if (!readyTranslations.has(task.id)) readyTranslations.set(task.id, bounded<any>(window.desktopAPI.translateSend(task.id), 45000, t('翻译响应较慢，原消息已保存。')).then(value => ({task:value}), error => ({error})))
  return readyTranslations.get(task.id)!
}
const bounded = <T,>(work: Promise<T>, ms: number, message: string): Promise<T> => new Promise((resolve, reject) => {
  const timer = window.setTimeout(() => reject(new Error(message)), ms)
  Promise.resolve(work).then(resolve, reject).finally(() => window.clearTimeout(timer))
})
const meta = (contact: any): SignalConversationPreference => preferences.value.conversations[contact?.id || recipient.value] || contact?.aliases?.map((id:string) => preferences.value.conversations[id]).find(Boolean) || {}
const currentPreference = computed(() => meta(activeContact.value || {id: recipient.value}))
const currentOutbox = computed(() => outbox.value.filter(item => item.peer === recipient.value && !messages.value.some(message => message.taskId === item.id)))
const darkSystem = ref(window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true)
const lightTheme = computed(() => preferences.value.theme === 'light' || preferences.value.theme === 'system' && !darkSystem.value)
const onThemeChange = (event: MediaQueryListEvent) => { darkSystem.value = event.matches }
async function refreshPreferences() { if (!window.desktopAPI.signalPreferences || !activeAccount.value) return; const value = await window.desktopAPI.signalPreferences(props.accountRecord.id); if (!disposed) preferences.value = value }
async function featuresChanged() { await refreshPreferences(); await refreshContacts() }
function editFolder(folder?: any) { folderEditor.value = folder || {}; folderName.value = folder?.name || ''; folderPeers.value = [...(folder?.peers || [])]; chatMenuOpen.value = false }
async function saveFolder(remove = false) { try { preferences.value = await window.desktopAPI.signalFolder(props.accountRecord.id, { id: folderEditor.value.id, name: folderName.value, peers: [...folderPeers.value], remove }); folderEditor.value = null; if (remove) activeFolder.value = '' } catch (e:any) { contactsError.value = e.message } }
async function createGroup() { if (groupBusy.value) return; groupBusy.value = true; try { const result = await window.desktopAPI.signalSaveGroup(props.accountRecord.id, null, { name: groupName.value, members: [...groupMembers.value] }); groupEditor.value = false; await refreshContacts(); if (result?.groupId) await selectConversation('group:' + result.groupId) } catch (e:any) { contactsError.value = e.message } finally { groupBusy.value = false } }
async function markRead() { if (!recipient.value || !window.desktopAPI.signalMarkRead || (document.visibilityState === 'hidden' || !document.hasFocus())) return; try { preferences.value = await window.desktopAPI.signalMarkRead(props.accountRecord.id, recipient.value) } catch {} }
async function saveAttachment(message:any, attachment:any) { try { await window.desktopAPI.signalAttachment(props.accountRecord.id, message.peer, attachment.id, true) } catch (e:any) { status.value = e.message } }
const pendingTask = ref<any>(null)
const contacts = ref<SignalContact[]>([]), contactFilter = ref(''), contactsBusy = ref(false), contactsError = ref('')
const accountsBusy = ref(false), newPeer = ref(''), showNewConversation = ref(false)
const messageList = ref<HTMLElement | null>(null), unread = ref<Record<string, number>>({})
let refreshTimer: ReturnType<typeof setInterval> | undefined
let expiryTimer: ReturnType<typeof setInterval> | undefined
const displayClock = ref(Date.now())
let stickToBottom = true
const activeContact = computed(() => contacts.value.find(item => item.id === recipient.value || item.aliases.includes(recipient.value)))
const visibleMessages = computed(() => messages.value.filter(message => message.account === activeAccount.value && !message.expired && (!message.expiresAt || message.expiresAt > displayClock.value) && (message.peer === recipient.value.trim() || activeContact.value?.aliases.includes(message.peer))).sort((a,b) => a.timestamp - b.timestamp))
const searchedMessages = computed(() => visibleMessages.value.filter(message => !messageSearch.value || (message.original + ' ' + (message.translated || '')).toLowerCase().includes(messageSearch.value.toLowerCase())))
const conversationMedia = computed(() => signalMediaEntries(visibleMessages.value).filter(item => ['image/', 'video/'].some(prefix => item.contentType.startsWith(prefix))))
const allConversations = computed(() => {
  const rows = new Map(contacts.value.map(item => [item.id, { ...item, lastText: '', timestamp: 0 }]))
  for (const message of messages.value.filter(item => item.account === activeAccount.value && !item.expired && (!item.expiresAt || item.expiresAt > displayClock.value))) {
    const contact = contacts.value.find(item => item.aliases.includes(message.peer))
    const id = contact?.id || message.peer
    const row = rows.get(id) || { id, aliases: [id], name: message.senderName || id, kind: id.startsWith('group:') ? 'group' as const : 'contact' as const, lastText: '', timestamp: 0 }
    if (message.timestamp >= row.timestamp) { row.timestamp = message.timestamp; row.lastText = message.translated || message.original || (message.attachments?.length ? t('[附件] ') + message.attachments[0].filename : '') }
    rows.set(id, row)
  }
  return [...rows.values()].map(item => ({ ...item, name: item.id === activeAccount.value ? t('备忘录') : item.name })).sort((a,b) => Number(meta(b).pinned === true) - Number(meta(a).pinned === true) || b.timestamp - a.timestamp || a.name.localeCompare(b.name))
})
const conversations = computed(() => {
  const query = contactFilter.value.trim().toLowerCase(), folder = preferences.value.folders.find(item => item.id === activeFolder.value)
  return allConversations.value.filter(item => (!query || (item.name + ' ' + item.aliases.join(' ')).toLowerCase().includes(query))
    && (showNewConversation.value ? !item.blocked && item.kind !== 'group' : (meta(item).archived ?? item.archived ?? false) === showArchived.value)
    && (!folder || showNewConversation.value || folder.peers.some(peer => item.aliases.includes(peer))))
})
const archivedCount = computed(() => allConversations.value.filter(item => meta(item).archived ?? item.archived).length)
function unreadCount(contact:any) { const pref = meta(contact); return Math.max(pref.markedUnread ? 1 : 0, messages.value.filter(item => item.account === activeAccount.value && !item.fromMe && contact.aliases.includes(item.peer) && item.timestamp > (pref.lastReadAt || 0)).length) }
const conversationTitle = computed(() => recipient.value === activeAccount.value ? t('备忘录') : activeContact.value?.name || allConversations.value.find(item => item.id === recipient.value)?.name || recipient.value)
const displayStatus = computed(() => /失败|超时|无法|失效|尚未|请先登录|检查连接|占用|failed|timed out|unavailable|expired|could not|invalid|not configured/i.test(status.value) && !/核对|未确认|原任务|unconfirmed|original task/i.test(status.value) ? uiError(status.value) : '')
const timeLabel = (time: number) => new Date(time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
function scrollPosition() { void scanDisplayTranslations(); const list = messageList.value; if (list) stickToBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 90 }
watch(visibleMessages, async () => { await nextTick(); if (stickToBottom && messageList.value) messageList.value.scrollTop = messageList.value.scrollHeight })
async function selectConversation(id: string) { void saveMainDraft(); recipient.value = id; unread.value[id] = 0; showNewConversation.value = false; detailsOpen.value = false; messageSearch.value = ''; searchOpen.value = false; stickToBottom = true; void markRead(); await nextTick(); if (messageList.value) messageList.value.scrollTop = messageList.value.scrollHeight }
async function openConversation() { try { const peer = normalizeSignalPeer(newPeer.value); await selectConversation(peer); newPeer.value = ''; showNewConversation.value = false; status.value = '' } catch (error: any) { contactsError.value = error.message } }
async function refreshContacts() {
  if (!activeAccount.value || contactsBusy.value || !runtimeReady.value || props.accountRecord.runtimeMode === 'paused') return
  const account = activeAccount.value; contactsBusy.value = true; contactsError.value = ''
  try { const rows = await window.desktopAPI.signalListContacts(account); if (!disposed && account === activeAccount.value) { contacts.value = rows; for (const contact of rows.filter((item:any) => item.hasAvatar && !(item.id in avatars.value)).slice(0,15)) { avatars.value[contact.id] = ''; void window.desktopAPI.signalAvatar?.(props.accountRecord.id, contact.id).then((value:string) => { if (!disposed && account === activeAccount.value) avatars.value[contact.id] = value }).catch(() => {}) } } }
  catch (error: any) { if (!disposed && account === activeAccount.value) contactsError.value = error.message || t('联系人暂时不可用。') }
  finally { contactsBusy.value = false }
}
async function syncContacts() {
  if (!activeAccount.value || contactsBusy.value || props.accountRecord.runtimeMode === 'paused') return
  try { await window.desktopAPI.signalSyncContacts(activeAccount.value); await refreshContacts() }
  catch (error: any) { contactsError.value = error.message || t('联系人同步失败，请检查手机连接。') }
}
let disposed = false
let recoverySequence = 0
let accountSave: Promise<any> = Promise.resolve()
const runtime = ref<any>({ state: 'checking', message: t('正在检查 Signal 核心…') })
let linkAttempt = 0
let offMessage: undefined | (() => void)
let offRuntime: undefined | (() => void)
let offDiagnostic: undefined | (() => void)
let offAction: undefined | (() => void), offBilling: undefined | (() => void)
const mainDraftTarget = () => ({ accountId: props.accountRecord.id, conversationId: 'signal:' + recipient.value.trim() })
async function saveMainDraft() { if (!recipient.value.trim()) return; try { await window.desktopAPI.saveDraft(mainDraftTarget(), input.value) } catch { status.value = t('草稿保存失败，请先复制输入内容。') } }
async function restoreMainDraft() {
  if (!recipient.value.trim() || input.value) return
  const target = mainDraftTarget()
  try { const saved = await window.desktopAPI.getDraft(target); if (!disposed && !input.value && target.conversationId === mainDraftTarget().conversationId) input.value = saved } catch {}
}
async function restoreHistory() { if (!activeAccount.value) return; const account = activeAccount.value; try { const history = await window.desktopAPI.signalHistory(account); if (!disposed && account === activeAccount.value) for (const message of history) messages.value = upsertMessage(messages.value, message) } catch {} }


const runtimeReady = computed(() => runtime.value?.state === 'ready')
const runtimeBusy = computed(() => ['checking', 'downloading-signal', 'downloading-java', 'installing'].includes(runtime.value?.state))
const translatedStyle = computed(() => ({
  display: props.accountRecord.translationsVisible === false ? 'none' : undefined,
  fontSize: `${Number(props.accountRecord.fontSize || 13)}px`,
  color: props.accountRecord.translationColor || '#c8d4e4'
}))
const prepareLabel = computed(() => {
  if (runtimeBusy.value) return t('正在准备…')
  if (runtime.value?.state === 'error') return t('重新准备')
  return t('准备 Signal')
})
const runtimeStateLabel = computed(() => {
  const state = runtime.value?.state
  if (state === 'ready') return t('已就绪')
  if (state === 'checking') return t('检查中')
  if (state === 'downloading-signal') return t('下载 Signal')
  if (state === 'downloading-java') return t('下载 Java')
  if (state === 'installing') return t('安装中')
  if (state === 'error') return t('错误')
  return t('未安装')
})

async function refreshRuntime() {
  try { runtime.value = await window.desktopAPI.signalRuntimeStatus() }
  catch (error: any) { runtime.value = { state: 'error', message: error.message || String(error) } }
}

async function prepareRuntime() {
  status.value = runtime.value?.state === 'error' ? t('正在修复 Signal 核心…') : t('正在准备 Signal 核心。首次使用会自动下载 signal-cli 和 Java 25…')
  diagnostic.value = ''
  try {
    runtime.value = await window.desktopAPI.signalPrepareRuntime()
    status.value = t('Signal 核心已准备并验证完成。')
    await refreshAccounts()
  } catch (error: any) { status.value = error.message || String(error) }
}

async function refreshAccounts() {
  if (!runtimeReady.value || accountsBusy.value || props.accountRecord.runtimeMode === 'paused') return
  accountsBusy.value = true
  try {
    const list = await window.desktopAPI.signalListAccounts()
    if (disposed) return
    signalAccounts.value = list
    if (activeAccount.value && !list.includes(activeAccount.value)) {
      activeAccount.value = ''; contacts.value = []
      status.value = t('原设备关联已失效，请重新关联手机 Signal。')
    } else if (!activeAccount.value && !props.accountRecord.signalAccount && list.length === 1) activeAccount.value = list[0]
    await refreshContacts()
  } catch (error: any) { if (!disposed) { status.value = error.message || t('Signal 连接失败。'); runtime.value = { state: 'error', message: t('Signal 暂时无法连接，请重新准备。') } } }
  finally { accountsBusy.value = false }
}

async function startLink() {
  if (linking.value) return
  if (!runtimeReady.value) await prepareRuntime()
  if (!runtimeReady.value) return
  const attempt = ++linkAttempt
  linking.value = true
  diagnostic.value = ''
  qr.value = ''
  linkUri.value = ''
  status.value = t('正在生成新的 Signal 设备关联链接…')
  try {
    const result = await window.desktopAPI.signalStartLink()
    if (attempt !== linkAttempt) return
    const uri = String(result?.deviceLinkUri || '')
    if (!uri.startsWith('sgnl://linkdevice?')) throw new Error(t('Signal 返回了无效的设备关联链接。'))
    linkUri.value = uri
    const finishPromise = window.desktopAPI.signalFinishLink(uri, 'HelloDog')
    qr.value = await QRCode.toDataURL(uri, { width: 260, margin: 2, errorCorrectionLevel: 'M' })
    status.value = t('请立即在手机 Signal 中打开“设置 → 已关联设备”扫描二维码。电脑端已在等待确认。')
    void completeLink(finishPromise, attempt)
  } catch (error: any) {
    if (attempt !== linkAttempt) return
    linking.value = false
    linkUri.value = ''
    qr.value = ''
    status.value = error.message || String(error)
  }
}

async function completeLink(finishPromise: Promise<any>, attempt: number) {
  try {
    const result = await finishPromise
    if (attempt !== linkAttempt) return
    const linkedNumber = String(result?.number || '')
    await refreshAccounts()
    if (linkedNumber) activeAccount.value = linkedNumber
    else if (!activeAccount.value && signalAccounts.value[0]) activeAccount.value = signalAccounts.value[0]
    if (activeAccount.value) await window.desktopAPI.updateAccount(props.accountRecord.id, { signalAccount: activeAccount.value })
    qr.value = ''
    linkUri.value = ''
    status.value = activeAccount.value ? t('Signal 绑定成功：{0}', activeAccount.value) : t('Signal 绑定成功。')
    await refreshContacts()
    emit('linked')
  } catch (error: any) {
    if (attempt !== linkAttempt) return
    qr.value = ''
    linkUri.value = ''
    const message = String(error?.message || error)
    status.value = /timed out/i.test(message) ? t('Signal 绑定超时。请重新点击“关联 Signal”生成新的二维码，并尽快扫码。') : t('Signal 绑定失败：{0}', message)
  } finally { if (attempt === linkAttempt) linking.value = false }
}

async function recoverPending() {
  const sequence = ++recoverySequence
  const current = scope()
  pendingTask.value = null
  if (!current.account || !current.peer) return
  try {
    const task = await window.desktopAPI.pendingSend(current.recordId, `signal:${current.peer}`)
    if (disposed || sequence !== recoverySequence || task?.signalAccount !== current.account) return
    pendingTask.value = task
    if (task && !input.value && !outbox.value.some(item => item.id === task.id) && !['uncertain', 'submitting'].includes(task.state)) input.value = task.request.text
  } catch (error: any) { if (!disposed && sequence === recoverySequence) status.value = error.message || String(error) }
}

const preview = ref<any>(null)
const previewText = ref(''), backResult = ref(''), backBusy = ref(false)
let finishPreview: ((value: string | null) => void) | undefined
function choosePreview(value: string | null) { finishPreview?.(value); finishPreview = undefined; preview.value = null }
async function backPreview() { if (!preview.value || backBusy.value) return; backBusy.value = true; const text = previewText.value; try { const value = await window.desktopAPI.backTranslateSend(preview.value.id, text); if (text === previewText.value) backResult.value = value } catch (e: any) { backResult.value = e.message } finally { backBusy.value = false } }
watch(previewText, () => { backResult.value = '' })
onUnmounted(() => choosePreview(null))

const displayKey = (message:any) => JSON.stringify([message.account,message.timestamp,message.peer,Boolean(message.fromMe),message.original])
const messageIdentity = (message:any) => ({account:message.account,peer:message.peer,timestamp:message.timestamp,fromMe:Boolean(message.fromMe)})
const displayAttempts = new Set<string>()
const displayFailures = new Map<string, {count: number; retryAt: number}>()
function applyDisplayResult(message:any, translated:unknown) {
  if (typeof translated !== 'string' || !translated.trim()) return
  messages.value = messages.value.map(item => displayKey(item) === displayKey(message) ? {...item,...(message.fromMe ? {displayTranslated:translated} : {translated})} : item)
}
let displayActive=0
async function scanDisplayTranslations() {
  if(disposed || !messageList.value || !window.desktopAPI.displaySignalMessage || document.visibilityState==='hidden' || props.accountRecord.runtimeMode==='paused' || props.accountRecord.translationsVisible===false)return
  const rect=messageList.value.getBoundingClientRect()
  const visible=new Set(Array.from(messageList.value.querySelectorAll<HTMLElement>('[data-message-id]')).filter(node=>{const r=node.getBoundingClientRect();return r.bottom>rect.top&&r.top<rect.bottom}).map(node=>node.dataset.messageId))
  for(const message of searchedMessages.value.slice().reverse()) {
    const key=displayKey(message)
    if(displayActive>=2)break
    const failure = displayFailures.get(key)
    if(!visible.has(key)||displayAttempts.has(key)||failure && failure.retryAt>Date.now()||message.system||message.expired||!message.original||!/\p{L}/u.test(message.original)||message.displayTranslated||message.translated&&message.translated!==message.original)continue
    displayAttempts.add(key);displayActive++
    const accountId=props.accountRecord.id, userId=props.userId, identity=messageIdentity(message)
    void bounded<any>(Promise.resolve().then(()=>window.desktopAPI.displaySignalMessage(accountId,identity)),45000,t('翻译响应较慢，原消息已保存。'))
      .then(value=>{ if (!disposed && props.accountRecord.id===accountId && props.userId===userId) { displayFailures.delete(key); applyDisplayResult(message,value) } })
      .catch(()=>{ if(disposed || props.accountRecord.id!==accountId || props.userId!==userId)return; const count=(displayFailures.get(key)?.count||0)+1; displayAttempts.delete(key); displayFailures.set(key,{count,retryAt:Date.now()+Math.min(300000,3000*2**Math.min(7,count-1))}) })
      .finally(()=>{displayActive--;if(!disposed)void scanDisplayTranslations()})
  }
}
watch(visibleMessages, async()=>{await nextTick();void scanDisplayTranslations()})
function retryDisplayFailures() { displayFailures.clear(); void scanDisplayTranslations() }
watch(()=>[props.accountRecord.id,props.accountRecord.receiveAutoTranslate,props.accountRecord.translationsVisible,props.accountRecord.historyMode,props.accountRecord.groupTranslate,props.accountRecord.localLanguage],()=>{displayAttempts.clear();displayFailures.clear();void nextTick(()=>scanDisplayTranslations())})
const translatingMessages = ref(new Set<string>())
async function translateMessage(message: any) {
  const key = message.timestamp + ':' + message.peer
  if (translatingMessages.value.has(key)) return
  translatingMessages.value.add(key)
  displayFailures.delete(displayKey(message)); displayAttempts.delete(displayKey(message))
  const accountId=props.accountRecord.id, userId=props.userId
  try { const translated = await bounded<any>(Promise.resolve().then(()=>window.desktopAPI.translateSignalMessage(accountId,messageIdentity(message))),45000,t('翻译响应较慢，原消息已保存。')); if(!disposed&&props.accountRecord.id===accountId&&props.userId===userId)applyDisplayResult(message,translated) }
  catch (e: any) { status.value = e.message || t('翻译失败') }
  finally { translatingMessages.value.delete(key) }
}

function onSendKey(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229 || event.shiftKey || event.altKey || event.metaKey) return
  if (!preferences.value.enterSends && !event.ctrlKey) return
  event.preventDefault(); void send()
}
async function send() {
  const text = input.value.trim()
  const attachmentIds = mediaDraft.value.map(file => file.id)
  const signalPayload = attachmentIds.length ? { attachments: attachmentIds, ...(mediaDraft.value.length === 1 && mediaDraft.value[0].isVoiceNote ? {voiceNote:true} : {}) } : undefined
  const current = scope()
  if (sending.value || mediaBusy.value || (!text && !attachmentIds.length) || !current.account || !current.peer || activeContact.value?.blocked) return
  sending.value = true
  try {
    saveDraft(localStorage, current, input.value)
    await bounded(accountSave, 8000, t('账号设置暂时没有响应，请重试。'))
    if (disposed || current.account !== activeAccount.value || current.peer !== recipient.value.trim()) throw new Error(t('对话已切换，草稿已保留。'))
    const prior = pendingTask.value
    const intentKey = 'hellodog-signal-prepare:' + JSON.stringify(current), snapshot = JSON.stringify([text,mediaIntent(signalPayload)])
    let savedIntent: any
    try { savedIntent = JSON.parse(localStorage.getItem(intentKey) || 'null') } catch {}
    const intentId = savedIntent?.snapshot === snapshot ? savedIntent.id : prior && prior.request.text === text && mediaIntent(prior.signalPayload) === mediaIntent(signalPayload) && !outbox.value.some(item => item.id === prior.id) ? prior.intentId : window.crypto?.randomUUID?.() || 'signal-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    localStorage.setItem(intentKey, JSON.stringify({snapshot,id:intentId}))
    const task = await bounded<any>(window.desktopAPI.prepareSignalSend(current.recordId, current.account, current.peer, text, intentId, signalPayload), 8000, t('本地保存暂时没有响应，请重试。'))
    pendingTask.value = task
    if (['uncertain', 'submitting'].includes(task.state)) { status.value = ''; return }
    if (!outbox.value.some(item => item.id === task.id)) outbox.value.push({ id: task.id, peer: current.peer, text: text || t('[附件]'), task, state: 'queued' })
    localStorage.removeItem(intentKey)
    if (current.account === activeAccount.value && current.peer === recipient.value.trim()) mediaTools.value?.acknowledge(attachmentIds)
    if (current.account === activeAccount.value && current.peer === recipient.value.trim() && input.value.trim() === text) {
      input.value = ''; void saveMainDraft()
    }
    status.value = ''
    prepareTranslation(task)
    workQueue = workQueue.catch(() => undefined).then(() => executeSend(task, current, text))
  } catch (error:any) { status.value = error.message || t('暂时无法发送，草稿已保留。') }
  finally { sending.value = false }
}

async function executeSend(originalTask:any, current:DraftScope, text:string) {
  const entry = outbox.value.find(item => item.id === originalTask.id)
  if (!entry) return
  let task = originalTask
  try {
    if (disposed) throw new Error(t('任务已保存，请返回此账号后重试。'))
    entry.state = 'translating'
    const prepared = await prepareTranslation(task)
    readyTranslations.delete(task.id)
    if (prepared.error) throw prepared.error
    task = prepared.task
    if (disposed) throw new Error(t('译文已保存，请返回此账号后重试。'))
    const settings = await bounded<any>(window.desktopAPI.getSettings(), 5000, t('暂时无法读取设置，请重试。'))
    if (settings.previewSend && task.translate !== false) {
      previewText.value = task.translated; backResult.value = ''; preview.value = { ...task, allowBack: settings.backTranslation }
      const edited = await new Promise<string | null>(resolve => { finishPreview = resolve })
      if (edited === null) { await window.desktopAPI.cancelSend(task.id); entry.state = 'cancelled'; entry.error = t('已取消'); return }
      if (disposed) throw new Error(t('译文已保存，没有发送。'))
      task = await window.desktopAPI.editSendPreview(task.id, edited)
    }
    entry.state = 'sending'; entry.translated = task.translated
    const sent = await bounded<any>(window.desktopAPI.submitSend(task.id), task.signalPayload?.attachments?.length ? 125000 : 45000, t('发送正在后台确认。'))
    if (disposed) return
    if (sent.state === 'uncertain') { entry.state = 'uncertain'; return }
    if (sent.result?.account) messages.value = upsertMessage(messages.value, sent.result)
    outbox.value = outbox.value.filter(item => item.id !== task.id)
    status.value = ''
  } catch (error: any) {
    // Once submitted, a lost reply is uncertain in every interface language.
    entry.state = entry.state === 'sending' || /后台确认|未确认|background|unconfirmed/i.test(error.message) ? 'uncertain' : 'failed'; entry.error = error.message || t('发送失败')
  } finally { if (!disposed) void recoverPending() }
}
function retryEntry(entry:any) {
  if (entry.state !== 'failed') return
  entry.state = 'queued'
  const current = { ...scope(), peer: entry.peer }
  workQueue = workQueue.catch(() => undefined).then(async () => {
    const task = entry.task || await window.desktopAPI.prepareSignalSend(current.recordId, current.account, entry.peer, entry.text, undefined, entry.signalPayload)
    if (task.id !== entry.id) entry.id = task.id
    await executeSend(task, current, entry.text)
  }).catch((error:any) => { entry.state = 'failed'; entry.error = error.message })
}

watch(input, value => {
  try { saveDraft(localStorage, scope(), value) }
  catch { status.value = t('本地草稿保存失败，请先复制输入内容。'); }
}, { flush: 'sync' })
watch([activeAccount, recipient], () => {
  choosePreview(null)
  input.value = readDraft(localStorage, scope())
  localStorage.setItem(peerKey, recipient.value)
  void recoverPending(); void restoreMainDraft(); void restoreHistory()
}, { flush: 'sync' })
watch(activeAccount, value => {
  if (value) {
    const id = props.accountRecord.id
    contacts.value = []
    accountSave = accountSave.catch(() => {}).then(() => window.desktopAPI.updateAccount(id, { signalAccount: value }))
    void accountSave.then(refreshContacts).catch(() => undefined)
    void accountSave.catch(error => { if (!disposed) status.value = error.message || String(error) })
  }
})
watch(recipient, value => {
  const peer = value.trim()
  if (peer) emit('conversation', { id: `signal:${peer}`, name: conversationTitle.value || peer })
}, { immediate: true })

onMounted(async () => {
  void window.desktopAPI.signalDesktopStatus?.(props.accountRecord.id).then((value:any)=>{desktopAvailable.value=value.available}).catch(()=>undefined)
  await window.desktopAPI.focusPlatform({ platform: 'signal' })
  if (disposed) return
  offAction = window.desktopAPI.onAccountAction((event:any) => { if (['refresh','refreshed'].includes(event.action) && event.accountId === props.accountRecord.id) { displayAttempts.clear(); displayFailures.clear(); void Promise.all([refreshRuntime(),refreshContacts(), restoreHistory(), refreshPreferences()]).catch(()=>{ status.value=t('刷新未完成，草稿已保留。') }) } if (event.action === 'send-resolved' && event.accountId === props.accountRecord.id) { void recoverPending() } if (event.action === 'quick-reply' && event.accountId === props.accountRecord.id) { if (input.value.trim() || !recipient.value.trim()) { status.value = t('请先选择收件人，并保留或清空已有草稿。'); return } input.value = event.text; void saveMainDraft() } })
  offBilling = window.desktopAPI.onBillingChanged(() => { void restoreHistory() })
  offChanged = window.desktopAPI.onSignalChanged?.((event:any) => { if (event.accountId === props.accountRecord.id) void featuresChanged() })
  window.addEventListener('focus',markRead)
  window.addEventListener('online',retryDisplayFailures)
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', onThemeChange)
  await restoreMainDraft(); await restoreHistory()
  offRuntime = window.desktopAPI.onSignalRuntime((next: any) => { runtime.value = next })
  offDiagnostic = window.desktopAPI.onSignalDiagnostic((message: string) => { diagnostic.value = message.trim() })
  offTyping = window.desktopAPI.onSignalTyping?.(acceptTyping)
  void window.desktopAPI.signalTypingSnapshot?.().then((values:SignalTyping[])=>values.forEach(acceptTyping)).catch(()=>{})
  offMessage = window.desktopAPI.onSignalMessage((message: any) => {
    if (!disposed && message.account === activeAccount.value) {
      if (!message.fromMe && !message.update) acceptTyping({account:message.account,peer:message.peer,sender:message.peer,started:false,timestamp:message.timestamp,expiresAt:Date.now()+15000})
      messages.value = upsertMessage(messages.value, message)
      if (!message.fromMe && !message.update) {
        if ([recipient.value, ...(activeContact.value?.aliases || [])].includes(message.peer)) void markRead()
        else unread.value[message.peer] = (unread.value[message.peer] || 0) + 1
        void refreshPreferences()
      }
    }
  })
  await refreshRuntime()
  if (runtimeReady.value) await refreshAccounts()
  await refreshPreferences(); void markRead()
  expiryTimer = setInterval(() => { displayClock.value = Date.now(); typingUsers.value=typingState.snapshot(); void scanDisplayTranslations() }, 1000)
  await recoverPending()
  refreshTimer = setInterval(() => { if (!linking.value && runtimeReady.value) { void refreshContacts(); void refreshPreferences(); void restoreHistory() } }, 20000)
})

onUnmounted(() => {
  disposed = true
  if (refreshTimer) clearInterval(refreshTimer)
  if (expiryTimer) clearInterval(expiryTimer)
  recoverySequence += 1
  linkAttempt += 1
  offMessage?.(); offTyping?.(); typingState.clear()
  offRuntime?.()
  offDiagnostic?.(); offAction?.(); offBilling?.(); offChanged?.()
  window.removeEventListener('focus',markRead)
  window.removeEventListener('online',retryDisplayFailures)
  window.matchMedia?.('(prefers-color-scheme: dark)').removeEventListener?.('change', onThemeChange)
})
</script>

<template>
  <div class="signal-view signal-chat" :class="{'signal-light': lightTheme}" :style="{'--signal-font': preferences.textSize + 'px'}">
    <div v-if="!runtimeReady || !activeAccount || qr" class="signal-connect">
      <div class="signal-connect-heading"><img :src="signalIcon" alt="" /><div><h2>{{ t('连接 Signal') }}</h2><p>{{ t('在手机 Signal 中打开「设置 → 已关联设备」。') }}</p></div></div>
      <p v-if="desktopAvailable"><button class="primary" @click="openDesktop">{{ t('打开 Signal 完整版') }}</button><small>{{ t('需单独扫码关联，原聊天数据保留。') }}</small></p>
      <div v-if="!runtimeReady" class="runtime-card">
        <div class="runtime-row"><strong>{{ runtime.message || t('正在检查连接…') }}</strong><span class="runtime-state">{{ runtimeStateLabel }}</span></div>
        <progress v-if="typeof runtime.progress === 'number'" :value="runtime.progress" max="100" />
        <button class="primary" :disabled="runtimeBusy" @click="prepareRuntime">{{ prepareLabel }}</button>
        <small>{{ t('准备不会删除手机上的消息或已有设备关联。') }}</small>
      </div>
      <template v-else>
        <div v-if="signalAccounts.length && !linking" class="signal-existing"><label>{{ t('使用已关联账号') }}<select v-model="activeAccount"><option value="">{{ t('选择账号') }}</option><option v-for="account in signalAccounts" :key="account" :value="account">{{ account }}</option></select></label></div>
        <div v-if="qr" class="qr-box signal-link-box"><img :src="qr" :alt="t('使用手机 Signal 扫描此关联二维码')" /><strong>{{ t('等待手机扫码确认') }}</strong><small>{{ t('确认后自动进入聊天，无需再次点击。') }}</small></div>
        <button v-else class="primary" :disabled="runtimeBusy || linking" @click="startLink">{{ linking ? t('正在连接…') : t('关联手机 Signal') }}</button>
      </template>
      <p v-if="status" class="status">{{ status }}</p>
    </div>
    <SignalSettings v-else-if="settingsOpen" :record-id="accountRecord.id" :account="activeAccount" :preferences="preferences" :contacts="contacts" :message-count="messages.filter(item => item.account === activeAccount).length" @close="settingsOpen = false" @change="featuresChanged" />
    <div v-else class="signal-workspace">
      <aside class="signal-conversations">
        <div class="signal-account"><button v-if="showArchived || showNewConversation" @click="showArchived = false; showNewConversation = false; contactFilter = ''" :aria-label="t('返回聊天列表')">‹</button><b>{{ showNewConversation ? t('新聊天') : showArchived ? t('已存档聊天') : t('聊天') }}</b><span class="signal-account-actions"><button @click="showNewConversation = !showNewConversation; showArchived = false; contactFilter = ''" :title="t('新聊天')" :aria-label="t('新建 Signal 对话')">＋</button><button @click="chatMenuOpen = !chatMenuOpen" :aria-label="t('Signal 聊天菜单')" :aria-expanded="chatMenuOpen">⋯</button></span></div>
        <div v-if="chatMenuOpen" class="signal-chat-menu"><button @click="showArchived = true; showNewConversation = false; chatMenuOpen = false; activeFolder = ''">{{ t('查看已存档 ') }}<span>{{ archivedCount }}</span></button><button @click="editFolder()">{{ t('添加聊天文件夹') }}</button><button @click="settingsOpen = true; chatMenuOpen = false">{{ t('Signal 设置') }}</button><button v-if="desktopAvailable" @click="openDesktop">{{ t('打开 Signal 完整版') }}</button><button @click="chatMenuOpen = false; startLink()">{{ t('关联其他账号') }}</button></div>
        <select v-if="signalAccounts.length > 1" v-model="activeAccount" class="signal-account-picker" :aria-label="t('Signal 账号')"><option v-for="account in signalAccounts" :key="account" :value="account">{{ account }}</option></select>
        <div class="signal-search"><input v-model="contactFilter" :placeholder="showNewConversation ? t('姓名、用户名或手机号') : t('搜索')" :aria-label="t('搜索 Signal 联系人')" /></div>
        <template v-if="showNewConversation"><div class="signal-new-actions"><button @click="groupEditor = true; groupName = ''; groupMembers = []">{{ t('♧ 新建群组') }}</button><button @click="newPeer = 'u:'">{{ t('@ 按用户名查找') }}</button><button @click="newPeer = '+'">{{ t('# 按手机号查找') }}</button><button @click="selectConversation(activeAccount)">{{ t('▤ 备忘录') }}</button></div><form class="signal-new-chat" @submit.prevent="openConversation"><input v-model="newPeer" :aria-label="t('手机号或 Signal 用户名')" :placeholder="t('+1… 或 username.12')" /><button type="submit" :disabled="!newPeer.trim()">{{ t('开始对话') }}</button></form></template>
        <p v-if="showArchived" class="signal-archive-note">{{ t('已存档的聊天仍会接收新消息。') }}</p>
        <div v-if="preferences.folders.length && !showNewConversation && !showArchived" class="signal-folders"><button :class="{active: !activeFolder}" @click="activeFolder = ''">{{ t('全部') }}</button><button v-for="folder in preferences.folders" :key="folder.id" :class="{active: activeFolder === folder.id}" @click="activeFolder = folder.id" @contextmenu.prevent="editFolder(folder)">{{ folder.name }}</button><button v-if="activeFolder" @click="editFolder(preferences.folders.find(item => item.id === activeFolder))" :title="t('编辑当前文件夹')">⋯</button></div>
        <div class="signal-contact-list">
          <button v-for="contact in conversations" :key="contact.id" class="signal-contact" :class="{ active: contact.id === recipient || contact.aliases.includes(recipient) }" @click="selectConversation(contact.id)">
            <img v-if="avatars[contact.id]" class="signal-contact-avatar" :src="avatars[contact.id]" alt="" /><span v-else class="signal-contact-avatar">{{ contact.id === activeAccount ? '▤' : contact.kind === 'group' ? '♧' : contact.name.slice(0,2).toUpperCase() }}</span><span class="signal-contact-copy"><b>{{ contact.name }} <small v-if="meta(contact).pinned">{{ t('置顶') }}</small></b><small>{{ contact.lastText || (contact.kind === 'group' ? t('群组') : contact.number || t('Signal 联系人')) }}</small></span><span class="signal-contact-tail"><time v-if="contact.timestamp">{{ new Date(contact.timestamp).toLocaleDateString(uiLanguage,{month:'numeric',day:'numeric'}) }}</time><span v-if="unreadCount(contact)" class="signal-contact-unread">{{ unreadCount(contact) }}</span></span>
          </button>
          <p v-if="!conversations.length" class="signal-empty-contacts">{{ contactsBusy ? t('正在读取联系人…') : contactFilter ? t('没有匹配的联系人') : t('手机联系人同步后会显示在这里，也可以用手机号开始对话。') }}</p>
        </div>
        <p v-if="contactsError" class="signal-contact-error">{{ contactsError }}</p>
        <div class="signal-bottom-actions"><button class="signal-sync" :disabled="contactsBusy || accountRecord.runtimeMode === 'paused'" @click="syncContacts">{{ accountRecord.runtimeMode === 'paused' ? t('账号已暂停') : contactsBusy ? t('正在刷新…') : t('同步联系人') }}</button><button class="signal-sync" @click="settingsOpen = true" :aria-label="t('打开 Signal 设置')">{{ t('⚙ 设置') }}</button></div>
      </aside>
      <div class="signal-chat-body">
      <section class="signal-conversation">
        <template v-if="recipient">
          <header class="signal-conversation-heading"><button class="signal-header-profile" @click="detailsOpen = !detailsOpen" :aria-label="t('查看 Signal 联系人资料')"><img v-if="avatars[recipient]" class="signal-contact-avatar" :src="avatars[recipient]" alt="" /><span v-else class="signal-contact-avatar">{{ activeContact?.kind === 'group' ? '♧' : conversationTitle.slice(0,1) }}</span><span><h3>{{ conversationTitle }}</h3><small v-if="typingHere" role="status">{{ t('正在输入…') }}</small><small v-else>{{ activeContact?.kind === 'group' ? (activeContact.members?.length || 0) + t(' 位群成员') : 'Signal' }}</small></span></button><button class="signal-header-search" @click="searchOpen = !searchOpen; messageSearch = ''" :aria-label="t('搜索当前 Signal 聊天')">⌕</button></header>
          <div v-if="searchOpen" class="signal-message-search"><input v-model="messageSearch" :placeholder="t('搜索这段聊天')" :aria-label="t('搜索当前聊天消息')" autofocus /><span>{{ searchedMessages.length }}{{ t(' 条') }}</span><button @click="searchOpen = false; messageSearch = ''">{{ t('关闭') }}</button></div>
          <div ref="messageList" class="messages signal-messages" @scroll="scrollPosition">
            <p v-if="!visibleMessages.length" class="signal-empty-chat">{{ t('从这里开始对话。此设备只显示关联后接收的消息。') }}</p>
            <div v-for="message in searchedMessages" :key="message.taskId || message.timestamp + ':' + message.peer + ':' + message.fromMe" class="msg" :data-message-id="displayKey(message)" :class="{ mine: message.fromMe, system: message.system }"><div class="bubble" :style="message.fromMe && currentPreference.color ? {background:currentPreference.color} : undefined"><small v-if="!message.fromMe && activeContact?.kind === 'group'">{{ message.senderName }}</small><div>{{ message.original }}</div><SignalMedia v-for="attachment in message.attachments || []" :key="attachment.id" :account-id="accountRecord.id" :peer="message.peer" :attachment="attachment" :timestamp="message.timestamp" :gallery="conversationMedia" /><button v-if="!message.displayTranslated && (!message.translated || message.translated === message.original) && message.original && !message.system && /\p{L}/u.test(message.original)" :disabled="translatingMessages.has(message.timestamp + ':' + message.peer)" :title="t('发起翻译，成功按字符计费')" @click="translateMessage(message)">{{ t('翻译') }}</button><div v-if="(message.displayTranslated || message.translated) && (message.displayTranslated || message.translated) !== message.original" class="translated" :style="translatedStyle">{{ message.displayTranslated || message.translated }}</div><time>{{ timeLabel(message.timestamp) }} <span v-if="message.fromMe">{{ message.delivery === 'read' ? t('✓✓ 已读') : message.delivery === 'delivered' ? t('✓✓ 已送达') : '✓' }}</span></time></div></div>
            <div v-for="entry in currentOutbox" :key="entry.id" class="msg mine signal-outbox"><div class="bubble"><div>{{ entry.text }}</div><small>{{ entry.state === 'failed' ? entry.error : entry.state === 'cancelled' ? t('已取消') : entry.state === 'translating' ? t('翻译中…') : entry.state === 'uncertain' ? t('发送中，等待回执') : t('发送中…') }}</small><button v-if="entry.state === 'failed'" @click="retryEntry(entry)">{{ t('重试') }}</button></div></div>
          </div>
          <div v-if="typingHere" class="signal-typing" role="status"><span aria-hidden="true">•••</span>{{ t('正在输入…') }}</div>
          <p v-if="displayStatus" class="signal-send-error">{{ displayStatus }}</p>
          <section v-if="preview" class="signal-preview"><label>{{ t('原文') }}<textarea :value="preview.request.text" readonly /></label><label>{{ t('可编辑译文') }}<textarea v-model="previewText" /></label><p v-if="backResult">{{ backResult }}</p><button class="primary" :disabled="!previewText.trim() || backBusy" @click="choosePreview(previewText.trim())">{{ t('发送译文') }}</button><button class="secondary" @click="choosePreview(null)">{{ t('取消') }}</button><button v-if="preview.allowBack" class="secondary" :disabled="backBusy" @click="backPreview">{{ t('回翻（新翻译，成功按字符计费）') }}</button></section>
          <div v-if="activeContact?.blocked" class="signal-blocked">{{ t('此联系人已屏蔽。') }}<button @click="detailsOpen = true">{{ t('查看资料') }}</button></div>
          <template v-else><SignalComposerTools ref="mediaTools" :account-id="accountRecord.id" :scope-key="JSON.stringify(scope())" :peer="recipient" :disabled="accountRecord.runtimeMode === 'paused'" @insert="input += $event" @change="mediaDraft = $event" @busy="mediaBusy = $event" /><div class="composer signal-composer" @dragover.prevent @drop="dropMedia"><textarea v-model="input" @input="saveMainDraft" @paste="pasteMedia" @keydown.enter="onSendKey" :placeholder="t('输入消息…')" :aria-label="t('Signal 消息')" /><button class="primary" :disabled="sending || mediaBusy || accountRecord.runtimeMode === 'paused' || (!input.trim() && !mediaDraft.length)" :title="t('发送消息')" @click="send">{{ t('发送') }}</button></div></template>
        </template>
        <div v-else class="signal-start"><img :src="signalIcon" alt="" /><h3>{{ t('选择一个联系人，开始聊天') }}</h3><p>{{ t('联系人、群组和此设备的新消息都会显示在左侧。') }}</p></div>
      </section>
      <SignalDetails v-if="detailsOpen && recipient" :record-id="accountRecord.id" :account="activeAccount" :peer="recipient" :preference="currentPreference" :messages="visibleMessages" :contacts="contacts" @close="detailsOpen = false" @change="featuresChanged" @search="detailsOpen = false; searchOpen = true" @conversation="selectConversation" />
      </div>
      <div v-if="folderEditor !== null || groupEditor" class="signal-local-overlay" @click.self="folderEditor = null; groupEditor = false">
        <form class="signal-local-dialog" @submit.prevent="groupEditor ? createGroup() : saveFolder()" role="dialog" :aria-label="groupEditor ? t('新建 Signal 群组') : t('编辑聊天文件夹')"><header><h3>{{ groupEditor ? t('新建群组') : folderEditor.id ? t('编辑聊天文件夹') : t('添加聊天文件夹') }}</h3><button type="button" @click="folderEditor = null; groupEditor = false" :aria-label="t('关闭编辑')">×</button></header><label>{{ groupEditor ? t('群组名称') : t('文件夹名称') }}<input v-if="groupEditor" v-model="groupName" maxlength="100" required /><input v-else v-model="folderName" maxlength="30" required /></label><div class="signal-dialog-contacts"><label v-for="contact in allConversations.filter(item => !item.blocked && (!groupEditor || item.kind !== 'group' && item.id !== activeAccount))" :key="contact.id"><span>{{ contact.name }}</span><input v-if="groupEditor" v-model="groupMembers" type="checkbox" :value="contact.id" /><input v-else v-model="folderPeers" type="checkbox" :value="contact.id" /></label></div><p v-if="contactsError" role="alert">{{ contactsError }}</p><footer><button type="button" @click="folderEditor = null; groupEditor = false">{{ t('取消') }}</button><button v-if="!groupEditor && folderEditor.id" type="button" @click="saveFolder(true)">{{ t('删除文件夹') }}</button><button type="submit" :disabled="groupBusy || groupEditor && (!groupMembers.length || !groupName.trim())">{{ groupBusy ? t('创建中…') : groupEditor ? t('创建群组') : t('保存') }}</button></footer></form>
      </div>
    </div>
  </div>
</template>

<style scoped>
.signal-view.signal-chat{display:flex;flex-direction:column;padding:0;min-height:0;height:100%;overflow:hidden;background:#181a20;color:#e8ecf2}
.signal-connect{overflow:auto;padding:24px;max-width:760px;width:100%;margin:auto}.signal-connect-heading{display:flex;gap:14px;align-items:center;margin-bottom:20px}.signal-connect-heading img{width:44px;height:44px}.signal-connect-heading h2{font-size:20px;margin:0}.signal-connect-heading p{color:#a8b2c0;font-size:12px}.runtime-card{margin:0 0 16px;padding:18px}.runtime-card small{display:block;margin-top:12px}.runtime-card progress{display:block;width:100%;margin:12px 0}.signal-existing{margin-bottom:12px}.signal-existing label{display:flex;gap:12px;align-items:center}.signal-link-box{display:flex;flex-direction:column;align-items:center;gap:10px;margin:12px auto}.signal-link-box img{width:220px;border-radius:12px}.signal-link-box small{color:#a8b2c0}
.signal-workspace{display:grid;grid-template-columns:245px minmax(0,1fr);height:100%;min-height:0}.signal-conversations{display:flex;flex-direction:column;min-height:0;border-right:1px solid #343b47;background:#1e222b;padding:12px;gap:10px}.signal-account{display:flex;align-items:center;justify-content:space-between}.signal-account button,.signal-search button{width:30px;height:30px;background:#2d3543;color:#dae4f5;border:0;border-radius:7px;font-size:19px;cursor:pointer}.signal-account-picker{width:100%;background:#202733;color:#c6d1e3;border:1px solid #394252;border-radius:7px;padding:7px;font-size:12px}.signal-search{display:flex;gap:6px}.signal-search input{min-width:0;width:100%;padding:8px;font-size:12px}.signal-new-chat{display:flex;flex-direction:column;gap:6px}.signal-new-chat input{padding:8px;min-width:0}.signal-contact-list{flex:1;min-height:0;overflow:auto;margin-inline:-5px}.signal-contact{display:flex;align-items:center;gap:9px;width:100%;padding:11px 7px;border:0;border-radius:9px;background:transparent;color:#e7edf8;text-align:left;cursor:pointer}.signal-contact:hover{background:#2a3241}.signal-contact.active{background:#303f5a}.signal-contact-avatar{flex-shrink:0;display:grid;place-items:center;width:34px;height:34px;border-radius:50%;background:#4268ad;color:#fff;font-size:13px}.signal-contact-copy{min-width:0;flex:1}.signal-contact-copy b,.signal-contact-copy small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.signal-contact-copy b{font-size:12px}.signal-contact-copy small{font-size:11px;color:#aab6ca;margin-top:5px}.signal-contact-unread{background:#5389ed;color:#fff;border-radius:12px;padding:2px 5px;font-size:10px}.signal-empty-contacts,.signal-contact-error{padding:10px;font-size:12px;line-height:1.6;color:#adb9cc}.signal-contact-error{color:#f4bd91;margin:0}.signal-sync{padding:8px;border:1px solid #394457;background:#262e3a;color:#bad0f5;border-radius:7px;font-size:11px;cursor:pointer}
.signal-conversation{display:flex;flex-direction:column;min-width:0;min-height:0}.signal-conversation-heading{padding:14px 20px;border-bottom:1px solid #333b47;flex-shrink:0}.signal-conversation-heading h3{margin:0;font-size:14px}.signal-conversation-heading small{display:block;color:#91a0b8;font-size:11px;margin-top:5px}.signal-messages{flex:1;min-height:0;overflow:auto;padding:16px 20px;border:0;margin:0}.signal-messages .msg{display:flex;margin-bottom:12px}.signal-messages .mine{justify-content:flex-end}.signal-messages .bubble{max-width:85%;padding:10px 13px;overflow-wrap:anywhere;font-size:13px;line-height:1.65}.signal-messages time{display:block;text-align:right;color:#a8b6ce;font-size:10px;margin-top:5px}.signal-messages .translated{margin-top:6px;padding-top:6px;border-top:1px solid #4c5b70}.signal-empty-chat{font-size:12px;color:#8f9aab;text-align:center;margin:30px 0}.signal-composer{display:flex;flex-shrink:0;gap:10px;border-top:1px solid #333b47;padding:12px 16px;margin:0;align-items:flex-end}.signal-composer textarea{flex:1;resize:vertical;min-height:64px;max-height:130px;padding:10px;min-width:0}.signal-composer button{white-space:nowrap;padding:12px;font-size:12px}.signal-send-error{margin:0;padding:8px 16px;font-size:12px;color:#efbc94}.signal-preview{margin:10px;overflow:auto;flex-shrink:0;max-height:210px}.signal-start{margin:auto;text-align:center;padding:24px;color:#94a1b6}.signal-start img{width:54px;height:54px;margin-bottom:12px}.signal-start h3{font-size:17px;color:#d6deec}.signal-start p{font-size:12px;line-height:1.8}
@media(max-width:1050px){.signal-workspace{grid-template-columns:210px minmax(0,1fr)}.signal-conversations{padding:10px}.signal-messages{padding:12px}.signal-composer{padding:10px;gap:6px}.signal-conversation-heading{padding:12px}.signal-composer button{padding:10px 8px}}
.signal-composer button.primary{color:#fff;background:#4169b6;border:0;border-radius:9px}
.signal-view.signal-chat{--signal-bg:#181818;--signal-side:#252525;--signal-text:#f1f1f1;--signal-muted:#adadad;--signal-border:#3c3c3c;--signal-button:#373737;--signal-input:#303030;--signal-selected:#404040;background:var(--signal-bg);color:var(--signal-text)}
.signal-view.signal-light{--signal-bg:#fff;--signal-side:#f5f5f5;--signal-text:#232323;--signal-muted:#6a6a6a;--signal-border:#dedede;--signal-button:#e9e9e9;--signal-input:#ededed;--signal-selected:#dce5ff}
.signal-workspace{position:relative;grid-template-columns:260px minmax(0,1fr)}.signal-chat-body{display:flex;min-width:0;min-height:0;position:relative}.signal-conversation{flex:1;min-width:0}.signal-conversations{position:relative;background:var(--signal-side);border-color:var(--signal-border);gap:12px;padding:18px 12px}.signal-account{gap:6px}.signal-account>b{font-size:18px;margin-left:6px}.signal-account-actions{display:flex;gap:6px}.signal-account button{background:transparent;color:var(--signal-text);font-size:25px}.signal-search input{border:0;border-radius:9px;background:var(--signal-input);color:var(--signal-text);font-size:13px;padding:9px 12px}.signal-contact{color:var(--signal-text);padding:12px 7px}.signal-contact.active{background:var(--signal-selected)}.signal-contact:hover{background:var(--signal-button)}.signal-contact-avatar{width:40px;height:40px;object-fit:cover;background:#c5d4ff;color:#30477d;font-size:14px}.signal-contact-copy b{font-size:13px}.signal-contact-copy small{color:var(--signal-muted);font-size:12px}.signal-contact-copy b small{display:inline;font-size:9px}.signal-contact-tail{display:flex;flex-direction:column;align-items:flex-end;gap:8px;flex-shrink:0}.signal-contact-tail time{font-size:10px;color:var(--signal-muted)}.signal-contact-unread{display:inline-block;padding:3px 6px}.signal-account-picker{background:var(--signal-input);color:var(--signal-text);border-color:var(--signal-border)}.signal-sync{background:var(--signal-button);border-color:var(--signal-border);color:var(--signal-text)}.signal-bottom-actions{display:flex;gap:8px}.signal-bottom-actions>button:first-child{flex:1}.signal-chat-menu{position:absolute;top:52px;right:12px;z-index:9;background:var(--signal-button);border:1px solid var(--signal-border);border-radius:9px;box-shadow:0 10px 24px #0006;min-width:178px;padding:6px}.signal-chat-menu button{display:flex;justify-content:space-between;gap:14px;width:100%;border:0;border-radius:5px;padding:10px 12px;text-align:left;background:transparent;color:var(--signal-text);font-size:12px;cursor:pointer}.signal-chat-menu button:hover{background:var(--signal-selected)}.signal-new-actions{display:flex;flex-direction:column;gap:3px}.signal-new-actions button{background:transparent;color:var(--signal-text);text-align:left;border:0;padding:10px;font-size:13px;border-radius:7px;cursor:pointer}.signal-new-actions button:hover{background:var(--signal-button)}.signal-new-chat input,.signal-new-chat button{border:1px solid var(--signal-border);border-radius:7px;background:var(--signal-input);color:var(--signal-text);font-size:12px;padding:8px}.signal-archive-note{font-size:11px;line-height:1.6;color:var(--signal-muted);margin:0;padding:4px 8px}.signal-folders{display:flex;gap:5px;overflow:auto;flex-shrink:0}.signal-folders button{border:0;padding:6px 10px;border-radius:15px;background:var(--signal-button);color:var(--signal-muted);white-space:nowrap;font-size:11px;cursor:pointer}.signal-folders button.active{background:#4068bf;color:#fff}.signal-conversation-heading{display:flex;justify-content:space-between;gap:8px;align-items:center;padding:12px 18px;border-color:var(--signal-border)}.signal-header-profile{display:flex;gap:12px;align-items:center;background:transparent;border:0;color:var(--signal-text);text-align:left;min-width:0;padding:0;cursor:pointer}.signal-header-profile>span:last-child{min-width:0}.signal-conversation-heading h3{white-space:nowrap;text-overflow:ellipsis;overflow:hidden;font-size:15px}.signal-conversation-heading small{color:var(--signal-muted)}.signal-header-search{background:transparent;color:var(--signal-text);border:0;font-size:26px;padding:6px;cursor:pointer}.signal-messages .bubble{background:var(--signal-button);color:var(--signal-text);font-size:var(--signal-font,14px);border-radius:16px;white-space:pre-wrap}.signal-messages .mine .bubble{background:#335fc1;color:#fff;border-radius:16px 16px 4px 16px}.signal-messages .system{justify-content:center}.signal-messages .system .bubble{background:transparent;color:var(--signal-muted);font-size:12px}.signal-messages time{color:var(--signal-muted)}.signal-messages .mine time{color:#d2def8}.signal-composer{border-color:var(--signal-border);padding:12px;gap:9px}.signal-composer textarea{background:var(--signal-input);color:var(--signal-text);border:0;border-radius:14px;min-height:50px;max-height:130px;font-size:var(--signal-font,14px)}.signal-composer button.primary{border-radius:22px;background:#4169e1;padding:12px 16px;font-size:13px}.signal-message-search{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--signal-border)}.signal-message-search input{flex:1;min-width:0;background:var(--signal-input);color:var(--signal-text);border:0;border-radius:7px;padding:8px;font-size:12px}.signal-message-search span{font-size:11px;color:var(--signal-muted)}.signal-message-search button{background:var(--signal-button);color:var(--signal-text);border:0;padding:7px;border-radius:6px;font-size:11px}.signal-attachment{display:block;text-align:left;border:0;border-radius:7px;padding:9px;background:#0002;color:inherit;max-width:100%;margin-top:6px;cursor:pointer}.signal-attachment small{display:block;font-size:10px;opacity:.7}.signal-outbox .bubble{opacity:.8}.signal-outbox small{display:block;margin-top:8px;font-size:11px}.signal-outbox button{margin-top:8px;padding:6px 10px;border:0;border-radius:6px;color:inherit;background:#ffffff20;cursor:pointer}.signal-blocked{padding:16px;text-align:center;font-size:12px;border-top:1px solid var(--signal-border)}.signal-blocked button{background:transparent;color:#8cb4ff;border:0;cursor:pointer}.signal-local-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#0008;z-index:12;padding:20px}.signal-local-dialog{display:flex;flex-direction:column;gap:14px;max-width:440px;width:100%;max-height:100%;background:var(--signal-side);color:var(--signal-text);border:1px solid var(--signal-border);border-radius:14px;padding:20px;box-shadow:0 16px 60px #0005}.signal-local-dialog header,.signal-local-dialog footer{display:flex;justify-content:space-between;align-items:center;gap:10px}.signal-local-dialog h3{margin:0;font-size:16px}.signal-local-dialog>label{display:flex;flex-direction:column;gap:8px;font-size:12px}.signal-local-dialog input:not([type=checkbox]){background:var(--signal-input);color:var(--signal-text);border:1px solid var(--signal-border);padding:10px;border-radius:7px;min-width:0}.signal-dialog-contacts{overflow:auto;min-height:0;max-height:270px}.signal-dialog-contacts label{display:flex;align-items:center;justify-content:space-between;padding:12px 2px;font-size:13px;gap:14px;border-bottom:1px solid var(--signal-border)}.signal-dialog-contacts input{accent-color:#527cff;width:17px;height:17px}.signal-local-dialog button{background:var(--signal-button);color:inherit;border:0;border-radius:7px;padding:8px 12px;cursor:pointer;font-size:12px}.signal-local-dialog button[type=submit]{background:#4169e1;color:#fff}.signal-local-dialog button:disabled{opacity:.4}.signal-local-dialog p{font-size:12px;color:#f1a08e}.signal-local-dialog footer{justify-content:flex-end}.signal-local-dialog header button{background:transparent;font-size:22px}
@media(max-width:1050px){.signal-workspace{grid-template-columns:220px minmax(0,1fr)}.signal-conversations{padding:12px 9px}.signal-contact-avatar{width:35px;height:35px}.signal-conversation-heading{padding:10px 12px}.signal-messages{padding:12px}.signal-contact-copy b{font-size:12px}.signal-contact-copy small{font-size:11px}}
</style>
