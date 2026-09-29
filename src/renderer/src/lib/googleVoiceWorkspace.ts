import { computed, ref } from 'vue'
import { orderedAccounts } from '../../../shared/accountOrder'
import { uiError, uiLanguage } from './uiLocale'
import { googleVoicePages, type GoogleVoicePage } from '../../../shared/googleVoicePage'
import { googleVoiceProxyConnectionKey, googleVoiceProxyNeedsReconnect } from '../../../shared/googleVoiceWindowConfig'
import type { GoogleVoiceNetworkState } from '../../../shared/googleVoiceNetwork'
import { parseGoogleVoiceRuntimeHealth, type GoogleVoiceRuntimeHealth } from '../../../shared/googleVoiceRuntimeHealth'

export type GoogleVoiceProxy = { enabled: boolean; protocol: 'http' | 'https' | 'socks5'; host: string; port: number; username?: string; hasPassword?: boolean }
export type GoogleVoiceNetwork = GoogleVoiceNetworkState
export type GoogleVoiceWindow = { id: string; label: string; tabOrder?: number; translationProvider?: 'deepseek' | 'openai'; proxy?: GoogleVoiceProxy }
export type GoogleVoiceWindowOptions = { label?: string; translationProvider?: 'deepseek' | 'openai'; proxy?: GoogleVoiceProxy & { password?: string; clearPassword?: boolean } }
export interface GoogleVoiceWorkspaceApi {
  listGoogleVoiceWindows(): Promise<GoogleVoiceWindow[]>
  addGoogleVoiceWindow(options?: GoogleVoiceWindowOptions): Promise<GoogleVoiceWindow>
  updateGoogleVoiceWindow(id: string, patch: GoogleVoiceWindowOptions): Promise<GoogleVoiceWindow>
  reorderGoogleVoiceWindows(ids: string[]): Promise<GoogleVoiceWindow[]>
  focusGoogleVoiceWindow(id?: string): Promise<unknown>
  refreshGoogleVoiceWindow(id: string): Promise<unknown>
  openGoogleVoiceExternal(id: string): Promise<unknown>
  backGoogleVoiceWindow?(id: string): Promise<unknown>
  closeGoogleVoiceWindow(id: string): Promise<boolean>
}

/** Voice windows have their own lifecycle, separate from translation accounts. */
export function useGoogleVoiceWorkspace(options: {
  api: () => GoogleVoiceWorkspaceApi
  beforeFocus: () => Promise<void>
  reportError: (message: string) => void
}) {
  const active = ref(false)
  const windows = ref<GoogleVoiceWindow[]>([])
  const selectedId = ref('')
  const state = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const message = ref('')
  const page = ref<GoogleVoicePage>('unknown')
  const runtimeHealth = ref<GoogleVoiceRuntimeHealth>()
  const translationNotice = computed(() => {
    const en = uiLanguage.value === 'en'
    if (state.value === 'loading') return en ? 'Opening the official page. Translation is not ready.' : '正在打开官方页面，翻译尚未就绪。'
    if (state.value === 'error') return en ? 'The page is unavailable. Translation is paused.' : '页面暂不可用，翻译已暂停。'
    if (state.value !== 'ready') return en ? 'Open a Google Voice text conversation to use translation.' : '请打开 Google Voice 短信会话后使用翻译。'
    if (page.value === 'access-help') return en ? 'Google is showing access restriction guidance. Check the account status; translation is unavailable on this page.' : 'Google 显示访问限制说明，请核对账号状态；此页面无法使用短信翻译。'
    if (page.value === 'sign-in') return en ? 'Complete Google sign-in or verification. Translation is unavailable on this page.' : '请完成 Google 登录或验证；此页面无法使用短信翻译。'
    if (page.value === 'help') return en ? 'This is a Google help page. Return to a Voice text conversation to translate.' : '当前为 Google 帮助页面，请返回短信会话后使用翻译。'
    if (page.value === 'product') return en ? 'This is the Google Voice introduction page. Open your text messages to translate.' : '当前为 Google Voice 产品介绍页面，请进入短信页面后使用翻译。'
    const health = runtimeHealth.value
    if (page.value === 'messages' || page.value === 'voice') {
      if (health?.code === 'preload-failed' || health?.code === 'runtime-unavailable') return en ? 'Translation did not start. Save your draft, then reload this page.' : '翻译未能启动，请先保留草稿，再重新加载页面。'
      if (health?.code === 'scan-failed') return en ? 'The conversation could not be read for translation. Save your draft, then reload this page.' : '翻译未能识别当前会话，请先保留草稿，再重新加载页面。'
      if (health?.code === 'status-unavailable') return en ? 'Translation settings could not be loaded. Check your connection and retry.' : '翻译设置尚未连接，请检查网络后重试。'
      if (health?.code === 'editor-unrecognized') return en ? 'The message editor has not been recognized. Sending is paused; existing messages can still be translated.' : '短信输入框暂未识别，发送已暂停；已有消息仍可翻译。'
      if (health?.code === 'message-unrecognized') return en ? 'No translatable text has been recognized in this conversation.' : '当前会话尚未识别到可翻译的文字消息。'
      if (health?.code === 'translation-disabled') return en ? 'Automatic incoming translation is off. Change it in Translation and alerts.' : '接收消息自动翻译已关闭，可在“翻译与通知”中开启。'
      if (health?.code === 'translations-hidden') return en ? 'Translations are hidden. Enable them in Translation and alerts.' : '译文已隐藏，可在“翻译与通知”中开启显示。'
      if (health?.code === 'manual-mode') return en ? 'Existing messages are not translated automatically. Change the history setting in Translation and alerts.' : '历史消息不会自动翻译，可在“翻译与通知”中调整历史翻译设置。'
      if (!health || health.code === 'waiting') return en ? 'Translation is preparing. Open a text conversation.' : '翻译正在准备，请打开短信会话。'
    }
    if (page.value === 'messages') return en ? 'Text page open. Translation follows your preferences; review the preview before sending.' : '短信页面已打开 · 翻译遵循当前偏好，发送前请核对预览。'
    return en ? 'The text page has not been confirmed. Open a Google Voice text conversation to translate.' : '请打开 Google Voice 短信会话；当前尚未确认短信页面。'
  })
  const canGoBack = ref(false)
  const networks = ref<Record<string, GoogleVoiceNetwork>>({})
  const network = computed(() => networks.value[selectedId.value])
  const writing = ref(false), listing = ref(0)
  const busy = computed(() => writing.value || listing.value > 0)
  const selected = computed(() => windows.value.find(window => window.id === selectedId.value))
  let focusRevision = 0, disposed = false
  let eventRevision = 0
  let mutationRevision = 0
  let pendingWrite: Promise<unknown> | undefined
  const refreshing = new Set<string>()
  const current = (revision: number) => !disposed && active.value && focusRevision === revision
  function failure(error: unknown): string {
    return uiError(error instanceof Error ? error.message : (uiLanguage.value === 'en' ? 'The Google Voice window could not be opened. Please try again.' : 'Google Voice 窗口暂时无法打开，请重试。'))
  }
  function showFailure(error: unknown) {
    if (disposed) return
    const text = failure(error)
    if (active.value) { state.value = 'error'; page.value = 'unknown'; message.value = text }
    else options.reportError(text)
  }
  function acceptState(value: any) {
    if(disposed || !windows.value.some(row=>row.id===value?.id))return
    if(value.network && ['proxy','system'].includes(value.network.mode) && ['unchecked','checking','checked','error'].includes(value.network.status)) networks.value[value.id] = { ...value.network }
    if(!active.value || value.id!==selectedId.value)return
    if(!['loading','ready','error'].includes(value.state))return
    eventRevision++;state.value=value.state;page.value=value.state==='ready'&&googleVoicePages.includes(value.page)?value.page:'unknown';message.value=typeof value.message==='string'?value.message:'';canGoBack.value=value.canGoBack===true
    runtimeHealth.value = value.state === 'ready' ? parseGoogleVoiceRuntimeHealth(value.runtimeHealth) : undefined
  }
  function acceptResult(result:unknown) {
    const value=result as {state?:string;message?:string;canGoBack?:boolean}|undefined
    if(value?.state==='cancelled'){state.value='idle';page.value='unknown';return}
    if(value && ['loading','ready','error'].includes(value.state||'')){acceptState({...value,id:selectedId.value});return}
    state.value='ready';page.value='unknown'
  }
  async function focus(id: string) {
    if (disposed || !windows.value.some(window => window.id === id)) return
    active.value = true
    const revision = ++focusRevision
    selectedId.value = id
    state.value = 'loading'; page.value = 'unknown'; message.value = ''
    try {
      await options.beforeFocus()
      if (!current(revision)) return
      const observed = eventRevision, result = await options.api().focusGoogleVoiceWindow(id)
      if (current(revision) && observed===eventRevision) acceptResult(result)
    } catch (error) { if (current(revision)) showFailure(error) }
  }
  async function enter() {
    if (disposed || active.value && state.value === 'loading') return
    active.value = true
    const revision = ++focusRevision
    state.value = 'loading'; page.value = 'unknown'; message.value = ''
    try {
      await options.beforeFocus()
      if (!current(revision)) return
      // Empty focus selects Voice's embedded workspace while loading its windows.
      await options.api().focusGoogleVoiceWindow()
      if (!current(revision)) return
      listing.value++
      let records: GoogleVoiceWindow[]
      try { records = await options.api().listGoogleVoiceWindows() }
      finally { listing.value-- }
      if (!current(revision)) return
      windows.value = orderedAccounts(records)
      const next = windows.value.find(window => window.id === selectedId.value) || windows.value[0]
      if (next) await focus(next.id)
      else { selectedId.value = ''; state.value = 'idle' }
    } catch (error) { if (current(revision)) showFailure(error) }
  }
  async function listForHome() {
    if (disposed || active.value || busy.value) return
    const revision = focusRevision, observedMutation = mutationRevision
    try { const records = await options.api().listGoogleVoiceWindows(); if (!disposed && !active.value && revision === focusRevision && observedMutation === mutationRevision) windows.value = orderedAccounts(records) }
    catch { /* Home remains usable; opening Voice reports connection errors. */ }
  }
  async function focusNotification(id: string) {
    if (disposed || !/^gv-[a-f0-9-]{36}$/.test(id)) return
    const revision = ++focusRevision
    try {
      const records = await options.api().listGoogleVoiceWindows()
      if (disposed || revision !== focusRevision || !records.some(record => record.id === id)) return
      windows.value = orderedAccounts(records)
      await focus(id)
    } catch (error) { if (!disposed && revision === focusRevision) options.reportError(failure(error)) }
  }
  function leave() {
    active.value = false
    focusRevision++
    canGoBack.value=false
    if (state.value === 'loading') state.value = 'idle'
  }
  async function write<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (busy.value || disposed) return
    mutationRevision++
    writing.value = true
    let operation: Promise<T> | undefined
    try { operation = action(); pendingWrite = operation; return await operation }
    catch (error) { if (!disposed) options.reportError(failure(error)); return }
    finally { if (pendingWrite === operation) pendingWrite = undefined; writing.value = false }
  }
  async function add(input?: GoogleVoiceWindowOptions) {
    const result = await write(async () => {
      const record = await options.api().addGoogleVoiceWindow(input)
      if (!disposed) windows.value = orderedAccounts([...windows.value.filter(window => window.id !== record.id), record])
      return record
    })
    if (result && active.value && !disposed) await focus(result.id)
    return !!result
  }
  async function configure(id: string, input: GoogleVoiceWindowOptions): Promise<boolean> {
    if (!windows.value.some(window => window.id === id)) return false
    const before = googleVoiceProxyConnectionKey(windows.value.find(window => window.id === id)?.proxy)
    let connectionChanged = false
    const result = await write(async () => {
      const saved = await options.api().updateGoogleVoiceWindow(id, input)
      connectionChanged = input.proxy !== undefined && googleVoiceProxyNeedsReconnect(before, saved.proxy, input.proxy)
      if (!disposed) {
        const index = windows.value.findIndex(window => window.id === id)
        if (index >= 0) windows.value[index] = saved
        if (connectionChanged) delete networks.value[id]
      }
      return saved
    })
    if (result && connectionChanged && active.value && selectedId.value === id && !disposed) await focus(id)
    return !!result
  }
  async function rename(id: string, label: string): Promise<boolean> {
    const value = label.trim().slice(0, 60)
    if (!value || !windows.value.some(window => window.id === id)) return false
    const result = await write(async () => {
      const saved = await options.api().updateGoogleVoiceWindow(id, { label: value })
      const existing = windows.value.find(window => window.id === id)
      if (!disposed && existing) existing.label = saved.label
      return saved
    })
    return !!result
  }
  async function setTranslationProvider(id: string, translationProvider: 'deepseek' | 'openai'): Promise<boolean> {
    if (!windows.value.some(window => window.id === id)) return false
    const result = await write(async () => {
      const saved = await options.api().updateGoogleVoiceWindow(id, { translationProvider })
      const existing = windows.value.find(window => window.id === id)
      if (!disposed && existing) existing.translationProvider = saved.translationProvider
      return saved
    })
    // Changing the translation provider never reloads a live page or its draft.
    return !!result
  }
  async function close(id: string) {
    const result = await write(async () => {
      const before = windows.value.findIndex(window => window.id === id)
      if (before < 0 || !await options.api().closeGoogleVoiceWindow(id)) return undefined
      if (disposed) return undefined
      const wasSelected = selectedId.value === id
      windows.value = windows.value.filter(window => window.id !== id)
      delete networks.value[id]
      if (!wasSelected) return undefined
      focusRevision++
      const next = windows.value[Math.min(before, windows.value.length - 1)]
      selectedId.value = next?.id || ''
      state.value = 'idle'
      return { next }
    })
    if (result && active.value && !disposed) {
      if (result.next) await focus(result.next.id)
      else {
        const revision = ++focusRevision
        try { await options.api().focusGoogleVoiceWindow() }
        catch (error) { if (current(revision)) showFailure(error) }
      }
    }
  }
  async function reorder(ids: string[]) {
    await write(async () => {
      const records = await options.api().reorderGoogleVoiceWindows(ids)
      if (disposed) return
      // Merge only order; a window rename must not be replaced by stale metadata.
      for (const record of records) {
        const existing = windows.value.find(window => window.id === record.id)
        if (existing) existing.tabOrder = record.tabOrder
      }
      windows.value = orderedAccounts(windows.value)
    })
  }
  async function retry() {
    if (busy.value) return
    // A live view can remain failed after a network/renderer error. Focusing it
    // alone cannot recover; refresh also rebuilds a destroyed view in main.
    if (selected.value) await refresh()
    else await enter()
  }
  async function refresh() {
    if (busy.value || !selected.value || !active.value) return
    const id = selected.value.id
    if (refreshing.has(id)) return
    refreshing.add(id)
    const revision = ++focusRevision
    state.value = 'loading'; page.value = 'unknown'; message.value = ''
    try {
      const observed=eventRevision,result = await options.api().refreshGoogleVoiceWindow(id)
      if (current(revision) && observed===eventRevision) acceptResult(result)
    } catch (error) { if (current(revision)) showFailure(error) }
    finally { refreshing.delete(id) }
  }
  async function external() {
    if (busy.value || !selected.value) return
    const revision = ++focusRevision
    const opened = await write(async () => { await options.api().openGoogleVoiceExternal(selected.value!.id); return true })
    if (opened && current(revision)) state.value = 'idle'
  }
  async function back() {
    if(busy.value || !active.value || !selected.value || !options.api().backGoogleVoiceWindow)return
    const revision=++focusRevision,observed=eventRevision
    try{const result=await options.api().backGoogleVoiceWindow!(selected.value.id);if(current(revision)&&observed===eventRevision)acceptResult(result)}catch(error){if(current(revision))showFailure(error)}
  }
  async function flush() { await pendingWrite }
  function dispose() { disposed = true; leave() }
  return { active, windows, selectedId, selected, state, page, runtimeHealth, translationNotice, message, canGoBack, network, busy, enter, listForHome, leave, focus, focusNotification, add, configure, rename, setTranslationProvider, close, reorder, retry, refresh, external, back, acceptState, flush, dispose }
}
