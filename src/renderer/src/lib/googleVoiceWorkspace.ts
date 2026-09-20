import { computed, ref } from 'vue'
import { orderedAccounts } from '../../../shared/accountOrder'
import { uiError, uiLanguage } from './uiLocale'

export type GoogleVoiceProxy = { enabled: boolean; protocol: 'http' | 'https' | 'socks5'; host: string; port: number; username?: string; hasPassword?: boolean }
export type GoogleVoiceNetwork = { mode: 'proxy' | 'system'; status: 'unchecked' | 'checking' | 'checked' | 'error'; ip?: string; latencyMs?: number; checkedAt?: number; message?: string }
export type GoogleVoiceWindow = { id: string; label: string; tabOrder?: number; proxy?: GoogleVoiceProxy }
export type GoogleVoiceWindowOptions = { label?: string; proxy?: GoogleVoiceProxy & { password?: string; clearPassword?: boolean } }
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
  const canGoBack = ref(false)
  const networks = ref<Record<string, GoogleVoiceNetwork>>({})
  const network = computed(() => networks.value[selectedId.value])
  const writing = ref(false), listing = ref(0)
  const busy = computed(() => writing.value || listing.value > 0)
  const selected = computed(() => windows.value.find(window => window.id === selectedId.value))
  let focusRevision = 0, disposed = false
  let eventRevision = 0
  let pendingWrite: Promise<unknown> | undefined
  const current = (revision: number) => !disposed && active.value && focusRevision === revision
  function failure(error: unknown): string {
    return uiError(error instanceof Error ? error.message : (uiLanguage.value === 'en' ? 'The Google Voice window could not be opened. Please try again.' : 'Google Voice 窗口暂时无法打开，请重试。'))
  }
  function showFailure(error: unknown) {
    if (disposed) return
    const text = failure(error)
    if (active.value) { state.value = 'error'; message.value = text }
    else options.reportError(text)
  }
  function acceptState(value: any) {
    if(disposed || !windows.value.some(row=>row.id===value?.id))return
    if(value.network && ['proxy','system'].includes(value.network.mode) && ['unchecked','checking','checked','error'].includes(value.network.status)) networks.value[value.id] = { ...value.network }
    if(!active.value || value.id!==selectedId.value)return
    if(!['loading','ready','error'].includes(value.state))return
    eventRevision++;state.value=value.state;message.value=typeof value.message==='string'?value.message:'';canGoBack.value=value.canGoBack===true
  }
  function acceptResult(result:unknown) {
    const value=result as {state?:string;message?:string;canGoBack?:boolean}|undefined
    if(value?.state==='cancelled'){state.value='idle';return}
    if(value && ['loading','ready','error'].includes(value.state||'')){acceptState({...value,id:selectedId.value});return}
    state.value='ready'
  }
  async function focus(id: string) {
    if (disposed || !windows.value.some(window => window.id === id)) return
    active.value = true
    const revision = ++focusRevision
    selectedId.value = id
    state.value = 'loading'; message.value = ''
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
    state.value = 'loading'; message.value = ''
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
  function leave() {
    active.value = false
    focusRevision++
    canGoBack.value=false
    if (state.value === 'loading') state.value = 'idle'
  }
  async function write<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (busy.value || disposed) return
    writing.value = true
    const operation = action()
    pendingWrite = operation
    try { return await operation }
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
    const result = await write(async () => {
      const saved = await options.api().updateGoogleVoiceWindow(id, input)
      if (!disposed) {
        const index = windows.value.findIndex(window => window.id === id)
        if (index >= 0) windows.value[index] = saved
        delete networks.value[id]
      }
      return saved
    })
    if (result && active.value && selectedId.value === id && !disposed) await focus(id)
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
    const revision = ++focusRevision, id = selected.value.id
    state.value = 'loading'; message.value = ''
    try {
      const observed=eventRevision,result = await options.api().refreshGoogleVoiceWindow(id)
      if (current(revision) && observed===eventRevision) acceptResult(result)
    } catch (error) { if (current(revision)) showFailure(error) }
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
  return { active, windows, selectedId, selected, state, message, canGoBack, network, busy, enter, leave, focus, add, configure, rename, close, reorder, retry, refresh, external, back, acceptState, flush, dispose }
}
