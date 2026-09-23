import { validId, translatedValue } from './protocol.mjs'
import { SendGuard } from './send-guard.mjs'
import { GoogleVoiceDomAdapter } from './voice-adapter.mjs'

/** Shared isolated-world UI. The transport is supplied by the extension or preload. */
export function installGoogleVoiceRuntime({ sendRequest, subscribe } = {}) {
  if (window !== window.top || location.origin !== 'https://voice.google.com' || typeof sendRequest !== 'function') return null
  const documentTicket = crypto.randomUUID(), logicalIds = new Map(), messages = new Map(), elementKeys = new WeakMap()
  const adapter = new GoogleVoiceDomAdapter(document, location)
  let panel, panelLifecycle, pending, bar, guard, guardConversation, runtimeStatus, statusAt = 0, scanTimer, scanBusy = false, epoch = 0, autoBusy = false, disposed = false, restoreListener, currentUrl = location.href
  let historyBaseline, statusReady = false, statusError = false
  const removers = []
  function listen(target, type, handler, capture = false) { target.addEventListener(type, handler, capture); removers.push(() => target.removeEventListener(type, handler, capture)) }
  function invalidate() {
    epoch++; runtimeStatus = null; statusAt = 0; statusReady = false; statusError = false; historyBaseline = null; guard?.invalidate(); guard = null; guardConversation = null; pending = null
    removeMessageViews(); panelLifecycle?.dismiss(); panelLifecycle = null; panel?.remove(); panel = null
    currentUrl = location.href
    if (!disposed) scheduleScan()
  }
  function checkNavigation() { if (currentUrl !== location.href) invalidate() }

  function showPanel(title, value, actions = [], note = '请核对内容。只有点击“确认发送”才会提交短信。', lifecycle) {
    if (disposed) return
    if (panelLifecycle && panelLifecycle !== lifecycle) panelLifecycle.dismiss()
    panelLifecycle = lifecycle
    panel?.remove(); panel = document.createElement('div')
    panel.style.cssText = 'position:fixed;bottom:24px;right:24px;width:min(440px,90vw);z-index:2147483647;'
    const shadow = panel.attachShadow({ mode: 'closed' }), style = document.createElement('style')
    style.textContent = ':host{all:initial}section{font:14px/1.5 system-ui;color:#eef6f2;background:#19232a;border:1px solid #48625a;border-radius:12px;padding:18px;box-shadow:0 8px 32px #0006}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}button{background:#32473f;color:#fff;border:0;border-radius:6px;padding:7px 10px;cursor:pointer}button:disabled{opacity:.5}textarea{box-sizing:border-box;width:100%;min-height:110px;max-height:35vh;background:#111a20;color:#eef6f2;border:1px solid #48625a;border-radius:6px;padding:10px;resize:vertical}p{color:#b9c9c3;font-size:12px;margin-bottom:0}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}'
    const section = document.createElement('section'), header = document.createElement('header'), heading = document.createElement('strong'), close = document.createElement('button')
    heading.textContent = title; close.textContent = '关闭'; close.type = 'button'; const currentPanel = panel
    close.onclick = () => {
      if (panel !== currentPanel || !currentPanel.isConnected) return
      panel = null; panelLifecycle = null; currentPanel.remove(); lifecycle?.dismiss(); scheduleScan()
    }
    const text = document.createElement('textarea'); text.readOnly = true; text.value = value; text.setAttribute('aria-label', '翻译结果'); text.onclick = () => text.select()
    const footer = document.createElement('p'); footer.textContent = note
    const controls = document.createElement('div'); controls.className = 'actions'
    for (const action of actions) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = action.label
      button.onclick = () => {
        if (panel !== currentPanel || !currentPanel.isConnected) return
        for (const child of controls.children) child.disabled = true
        Promise.resolve().then(() => { if (panel === currentPanel && currentPanel.isConnected) return action.run() })
          .catch(error => { if (panel === currentPanel && currentPanel.isConnected) showError(error) })
          .finally(() => { for (const child of controls.children) child.disabled = false })
      }
      controls.append(button)
    }
    header.append(heading, close); section.append(header, text, controls, footer); shadow.append(style, section)
    for (const type of ['keydown', 'keyup', 'keypress', 'click', 'pointerdown', 'beforeinput']) section.addEventListener(type, event => event.stopPropagation())
    ;(document.body || document.documentElement).append(panel)
  }
  async function request(type, payload) {
    checkNavigation()
    if (disposed || location.origin !== 'https://voice.google.com') throw new Error('页面已离开，操作已停止。')
    const startedEpoch = epoch, startedUrl = location.href
    // A lost IPC reply must not leave the entire scan/preview permanently busy.
    // The main process still owns the original work and its immutable request
    // identity; timing out this UI wait never cancels or resends that work.
    const answer = await new Promise((resolve, reject) => {
      const failure = code => { const error = new Error('翻译响应暂未完成，原请求已保留，可稍后重试。'); error.code = code; return error }
      const timer = setTimeout(() => reject(failure('timeout')), 75000)
      Promise.resolve().then(() => sendRequest({ v: 1, type: 'voice.' + type, ...(payload ? { payload } : {}) }))
        .then(resolve, () => reject(failure('unavailable'))).finally(() => clearTimeout(timer))
    })
    if (disposed || epoch !== startedEpoch || location.href !== startedUrl) throw new Error('账号或页面已变化，操作已停止，未发送短信。')
    if (!answer?.ok) { const error = new Error(typeof answer?.error === 'string' ? answer.error : 'HelloDog 尚未完成操作，已保留原文。'); error.code = answer?.code; throw error }
    return answer.result
  }
  const bridge = { status: () => request('status'), translate: payload => request('translate', payload), authorize: payload => request('authorize', payload), logicalId: payload => request('outgoing-id', payload), dispatchStatus: payload => request('dispatch-status', payload), dispatchResolve: payload => request('dispatch-resolve', payload) }
  function showUncertain(currentGuard, value = '请查看 Google Voice 官方聊天记录，核对这条短信是否已发送。核对前不会再次发送。') {
    showPanel('HelloDog · 发送结果待核对', value, [
      { label: '已核对：确认已发送', run: async () => { await currentGuard.resolve('sent'); showPanel('HelloDog · 已记录发送结果', '已确认发送。不会自动再次发送。', [], '原站显示的送达状态仍以 Google Voice 为准。') } },
      { label: '已核对：确认未发送', run: async () => { await currentGuard.resolve('not-sent'); showPanel('HelloDog · 已记录发送结果', '已确认未发送。请核对草稿后手动重新发起。', [], '不会自动重试或发送。') } }
    ], '仅在你已查看官方记录并确认结果后选择。请勿凭等待时间判断未发送。')
  }
  function showError(error) {
    const value = typeof error?.message === 'string' ? error.message : '操作尚未完成，原消息未改动。'
    if (guard?.state === 'uncertain') showUncertain(guard, value + '\n\n请先查看官方聊天记录，再核对发送结果。')
    else showPanel('HelloDog · 尚未完成', value, [], '不会发送中文原文，不会自动重发。未知页面结构不保证全部发送入口均已识别。')
  }
  async function prepareOutgoing() {
    checkNavigation()
    const startedEpoch = epoch
    if (!await adapter.refresh()) throw new Error(adapter.reason || '当前短信编辑器尚未识别，已阻止此发送操作。')
    if (disposed || epoch !== startedEpoch) return
    const snapshot = adapter.snapshot()
    if (!guard || guardConversation !== snapshot.conversationId) { guard = new SendGuard(adapter, bridge); guardConversation = snapshot.conversationId }
    const active = guard
    let dismissed = false
    const lifecycle = { dismiss() { if (dismissed) return; dismissed = true; active.dismissPreview(); scheduleScan() } }
    showPanel('HelloDog · 正在准备预览', '正在核对连接、此前发送结果及翻译。请保留草稿。', [], snapshot.text.trim() ? '尚未发送短信。需要翻译的文字在成功后扣字符；关闭面板不会取消已开始的翻译。' : '尚未发送短信。纯图片不调用文字翻译，不扣文字字符。', lifecycle)
    let preview
    try { preview = await active.prepare() } catch (error) { if (!dismissed && !disposed && epoch === startedEpoch) throw error; return }
    if (dismissed || disposed || epoch !== startedEpoch) return
    if (guard !== active || adapter.snapshot()?.conversationId !== snapshot.conversationId) throw new Error('会话已变化，译文未发送。')
    toolbar(adapter.supported)
    const targetNote = preview.context ? `已选 ${preview.context.recipientCount} 位收件人，请核对官方收件人列表。\n\n` : ''
    const previewText = targetNote + (preview.media ? `已核对 ${preview.media.count} 张图片，请同时核对原站图片预览。${preview.text ? '\n\n' + preview.text : '\n没有文字说明；此操作不调用文字翻译。'}` : preview.text)
    const billingNote = preview.untranslated ? (preview.media && !preview.text ? '纯图片不扣文字字符。请核对图片与收件人，确认后才发送。' : '本条文字无需翻译，不扣翻译字符。请核对内容，确认后才发送。') : '文字翻译成功时扣字符；关闭预览不退还已扣字符，确认发送不再重复扣费。请核对内容，确认后才发送。'
    showPanel(preview.media ? 'HelloDog · 图片发送前预览' : preview.untranslated ? 'HelloDog · 原文无需翻译' : 'HelloDog · 发送前预览', previewText, [{ label: '确认发送', run: async () => {
      if (dismissed) return
      try { await active.confirm() } catch (error) { if (!dismissed && !disposed && epoch === startedEpoch) throw error; return }
      if (dismissed || disposed || epoch !== startedEpoch) return
      showPanel('HelloDog · 已提交', '已执行一次原站发送操作。送达情况以 Google Voice 官方聊天为准。', [], '可以继续编辑其他短信。同文再次发送前需要先核对此次结果；不会自动重发。')
    } }], billingNote, lifecycle)
  }
  // Installed before the app's document handlers. Unverified recipients and
  // attachment surfaces using these known controls are blocked, not guessed.
  for (const type of ['keydown', 'keyup', 'keypress', 'beforeinput', 'click', 'submit', 'paste', 'drop']) listen(window, type, event => {
    checkNavigation()
    const intent = adapter.eventIntent(event)
    if (!intent) return
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation()
    if (intent === 'attachment') { showError(new Error('仅支持 JPEG、PNG、GIF 或 BMP 图片，最多 10 张、合计 20 MB；单张 GIF 不超过 2 MB。视频和音频附件不在此发送范围内。')); return }
    if (event.isComposing || event.keyCode === 229 || event.ctrlKey || event.altKey || event.metaKey || type === 'keyup' || type === 'keypress' || type === 'beforeinput') return
    void prepareOutgoing().catch(showError)
  }, true)

  function toolbar(supported) {
    const entry = document.querySelector('gv-message-entry')
    if (!entry) { bar?.remove(); bar = null; return }
    if (!bar?.isConnected || bar.nextSibling !== entry) {
      bar?.remove(); bar = document.createElement('div'); bar.dataset.hellodogVoice = 'toolbar'
      bar.style.cssText = 'font:12px/1.5 system-ui;padding:7px 12px;background:#19232a;color:#e5f2eb;border-top:1px solid #48625a;display:flex;gap:12px;align-items:center;'
      const label = document.createElement('span'), button = document.createElement('button'); button.type = 'button'; button.textContent = '翻译预览'
      button.style.cssText = 'background:#32473f;color:#fff;border:0;border-radius:5px;padding:5px 9px;cursor:pointer;'; button.onclick = () => { void prepareOutgoing().catch(showError) }
      bar.append(label, button); entry.before(bar)
    }
    bar.firstChild.textContent = supported ? runtimeStatus?.connected ? '文字翻译成功扣字符 · 发送先预览' : statusError ? 'HelloDog 状态暂未确认，请稍后重试' : '发送前需连接 HelloDog' : adapter.reason || '当前编辑器未识别 · 已阻止已知发送入口'
    bar.lastChild.disabled = !supported
  }
  async function translateMessage(item, manual) {
    if (!adapter.validMessage(item)) return
    const key = item.conversationId + ':' + item.id, cached = messages.get(key)
    if (cached?.work || cached?.text) return cached?.text
    const state = cached || {}; messages.set(key, state); const startedEpoch = epoch
    state.work = true; state.error = false; state.deferred = false; renderMessageViews(state)
    try {
      const newMessage = !manual && runtimeStatus?.historyMode === 'new' && historyBaseline?.eligible.has(item.id)
        ? { token: historyBaseline.token, anchorId: historyBaseline.anchorId, timestamp: item.timestamp, messageDirection: item.direction } : undefined
      const result = await bridge.translate({ id: item.id, conversationId: item.conversationId, direction: 'incoming', text: item.text, manual, ...(newMessage ? { newMessage } : {}) })
      if (epoch !== startedEpoch) return
      // Mode/cache misses are a normal receipt, not a failed translation. Do
      // not repeatedly query/charge a disabled message on the polling loop.
      if (result?.enabled === false) { state.deferred = true; return }
      const value = translatedValue(result)
      state.text = value.text; state.retryAfter = 0; state.failures = 0; state.retryWindow = 0; state.recoverable = false
    } catch (error) {
      if (epoch === startedEpoch) {
        const now = Date.now()
        state.recoverable = ['timeout', 'unavailable'].includes(error?.code)
        if (error?.code === 'busy') { state.error = false; state.retryAfter = now + 2000 }
        else if (state.recoverable) {
          if (manual || !state.retryWindow || now - state.retryWindow >= 300000) { state.retryWindow = now; state.failures = 0 }
          state.failures = (state.failures || 0) + 1
          // Two delayed automatic retries per five-minute window, then leave
          // an actionable button. Engine recovery retains the original ID or
          // retries only a cloud-confirmed uncharged failure.
          state.error = state.failures > 2
          state.retryAfter = state.error ? state.retryWindow + 300000 : now + 5000 * 2 ** (state.failures - 1)
        } else { state.error = true; state.retryAfter = 0 }
        if (manual) showError(error)
      }
    }
    finally { state.work = false; renderMessageViews(state); scheduleScan() }
  }
  function removeMessageViews() { for (const state of messages.values()) for (const view of state.views?.values() || []) view.node.remove(); messages.clear() }
  function renderMessageViews(state) {
    for (const [element, view] of state.views || []) {
      if (!element.isConnected) { state.views.delete(element); continue }
      if (!adapter.validMessage(view.item)) continue
      view.node.style.display = runtimeStatus?.translationsVisible === false ? 'none' : ''
      if (runtimeStatus?.localLanguage) view.node.lang = runtimeStatus.localLanguage
      if (state.text) { if (view.node.textContent !== state.text) view.node.textContent = state.text }
      else { view.button.textContent = state.work ? '翻译中…' : state.error ? '重试翻译' : state.retryAfter ? '等待翻译' : '翻译'; view.button.disabled = state.work === true }
    }
  }
  function addMessage(item) {
    const key = item.conversationId + ':' + item.id
    const previousKey = elementKeys.get(item.element)
    if (previousKey && previousKey !== key) {
      const previous = messages.get(previousKey); previous?.views.get(item.element)?.node.remove(); previous?.views.delete(item.element)
    }
    elementKeys.set(item.element, key)
    let state = messages.get(key)
    if (!state && messages.size >= 500) {
      const obsolete = [...messages].find(([, old]) => !old.work && ![...old.views?.keys() || []].some(element => element.isConnected))
      if (!obsolete) return null
      messages.delete(obsolete[0])
    }
    if (!state) { state = { views: new Map() }; messages.set(key, state) }
    const oldView = state.views.get(item.element)
    if (!oldView?.node.isConnected || oldView.node.parentElement !== item.content) {
      oldView?.node.remove(); const node = document.createElement('div'); node.dataset.hellodogVoice = 'translation'
      // Keep the original annotation/links untouched, with the translation
      // below it inside the same native bubble (before the official timestamp).
      // Inherit its foreground for readable light/dark and incoming/outgoing
      // colors instead of applying a low-contrast fixed green to white pages.
      node.dir = 'auto'; node.setAttribute('aria-label', '译文')
      node.style.cssText = 'font:13px/1.55 system-ui;color:inherit;box-sizing:border-box;max-width:100%;min-width:0;margin:6px 0 0;padding:6px 0 0;border-top:1px solid color-mix(in srgb,currentColor 22%,transparent);white-space:pre-wrap;overflow-wrap:anywhere;word-break:normal;text-align:start;user-select:text;'
      const button = document.createElement('button'); button.type = 'button'; button.textContent = state.error ? '重试翻译' : '翻译'
      button.style.cssText = 'font:12px system-ui;color:inherit;background:transparent;border:0;cursor:pointer;padding:3px 0;'
      button.onclick = () => { void translateMessage(item, true) }
      node.append(button); item.content.append(node); state.views.set(item.element, { node, button, item })
    } else oldView.item = item
    renderMessageViews(state)
    return state
  }
  async function observeNewMessages(items) {
    if (runtimeStatus?.historyMode !== 'new' || !runtimeStatus.newMessageTracking || !runtimeStatus.receiveAutoTranslate || runtimeStatus.translationsVisible === false) { historyBaseline = null; return }
    if (!statusReady || !items.length) return
    const first = items[0], before = historyBaseline
    // Retiring an anchor, replacing the entire thread or reaching a bounded
    // tracking limit establishes a fresh baseline, never a catch-up charge.
    if (!before || before.expiresAt <= Date.now() || before.thread !== first.thread || before.conversationId !== first.conversationId || before.seen.size + items.length > 1000 || !items.some(item => item.id === before.anchorId) || !items.some(item => item.id === before.tailId)) {
      historyBaseline = null
      if (items.length > 500) return
      const reply = await request('history-baseline', { conversationId: first.conversationId, ids: items.map(item => item.id) })
      if (!validId(reply?.token) || !Number.isSafeInteger(reply.startedAt) || !Number.isSafeInteger(reply.expiresAt) || reply.expiresAt <= Date.now() || reply.anchorId !== items[items.length - 1].id || !items.every(item => adapter.validMessage(item))) return
      const settled = await adapter.messages()
      if (settled.length !== items.length || settled.some((item, index) => item.id !== items[index].id || item.thread !== first.thread)) { scheduleScan(); return }
      historyBaseline = { ...reply, thread: first.thread, conversationId: first.conversationId, tailId: reply.anchorId, seen: new Set(items.map(item => item.id)), eligible: new Set() }
      return
    }
    const tail = items.findIndex(item => item.id === before.tailId)
    for (let index = 0; index < items.length; index++) {
      const item = items[index], previousKey = elementKeys.get(item.element)
      // A prepend, rerender or recycled DOM node is not a newly received SMS.
      // Main additionally proves timestamp freshness against its own baseline.
      if (!before.seen.has(item.id) && index > tail && item.direction === 'incoming' && (!previousKey || previousKey === item.conversationId + ':' + item.id)) before.eligible.add(item.id)
      before.seen.add(item.id)
    }
    before.tailId = items[items.length - 1].id
  }
  async function scan() {
    scanTimer = null
    checkNavigation()
    if (disposed || scanBusy) return
    scanBusy = true
    const startedEpoch = epoch
    try {
      const supported = await adapter.refresh()
      if (disposed || startedEpoch !== epoch) return
      toolbar(supported)
      // Incoming history remains readable while a draft is uploading, a
      // composer is disabled, or an unknown send surface is safely blocked.
      if (Date.now() - statusAt > 10000 && !autoBusy && !['preparing', 'authorizing'].includes(guard?.state)) {
        statusAt = Date.now()
        try {
          const next = await bridge.status()
          if (disposed || startedEpoch !== epoch) return
          if (runtimeStatus && runtimeStatus.localLanguage !== next.localLanguage) invalidate()
          else if (['receiveAutoTranslate', 'historyMode', 'translationsVisible'].some(key => runtimeStatus?.[key] !== next[key])) { historyBaseline = null; for (const state of messages.values()) state.deferred = false }
          runtimeStatus = next; statusReady = true; statusError = false
        } catch (error) {
          if (disposed || startedEpoch !== epoch) return
          statusReady = false; statusError = true
          // A busy receipt says nothing about the last verified connection.
          // Keep its display but pause automatic work until status is fresh.
          if (error?.code === 'busy') statusAt = Date.now() - 9000
          else { runtimeStatus = null; historyBaseline = null }
        }
        toolbar(supported)
      }
      const items = await adapter.messages()
      if (disposed || startedEpoch !== epoch) return
      try { await observeNewMessages(items) } catch (error) { if (error?.code === 'busy') scheduleScan(); else historyBaseline = null }
      if (disposed || startedEpoch !== epoch) return
      let nextAuto
      for (const item of items) {
        if (!adapter.validMessage(item)) continue
        const state = addMessage(item)
        if (state?.error && state.recoverable && state.retryAfter && Date.now() >= state.retryAfter) { state.error = false; state.retryAfter = 0; state.failures = 0; state.retryWindow = 0; renderMessageViews(state) }
        const automatic = runtimeStatus?.historyMode === 'visible' || runtimeStatus?.historyMode === 'new' && historyBaseline?.eligible.has(item.id)
        if (!nextAuto && automatic && state && !state.work && !state.text && !state.error && !state.deferred && (!state.retryAfter || Date.now() >= state.retryAfter) && item.automatic && (runtimeStatus?.historyMode === 'new' || adapter.visibleMessage(item))) nextAuto = item
      }
      if (nextAuto && statusReady && runtimeStatus?.connected && runtimeStatus.receiveAutoTranslate && runtimeStatus.translationsVisible !== false && navigator.onLine !== false && document.visibilityState === 'visible' && !autoBusy && !['preparing', 'authorizing', 'preview'].includes(guard?.state)) {
        autoBusy = true
        try { await translateMessage(nextAuto, false) } finally { autoBusy = false; scheduleScan() }
      }
    } finally { scanBusy = false }
  }
  function scheduleScan() { if (!disposed && !scanTimer) scanTimer = setTimeout(() => { void scan().catch(() => {}) }, 250) }
  const observer = new MutationObserver(changes => { checkNavigation(); if (changes.some(change => !change.target.closest?.('[data-hellodog-voice]'))) scheduleScan() })
  observer.observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'disabled', 'aria-readonly', 'src', 'style'] })
  listen(window, 'popstate', () => { checkNavigation(); scheduleScan() }); listen(window, 'hashchange', checkNavigation)
  listen(window, 'scroll', scheduleScan, true); listen(document, 'visibilitychange', () => { if (document.visibilityState === 'visible') for (const state of messages.values()) state.deferred = false; scheduleScan() })
  listen(window, 'online', () => { statusAt = 0; scheduleScan() })
  listen(document, 'hellodog-voice-draft-ready', scheduleScan)
  listen(document, 'hellodog-voice-attachment-rejected', () => showError(new Error('仅支持 JPEG、PNG、GIF 或 BMP 图片，最多 10 张、合计 20 MB；单张 GIF 不超过 2 MB。此次选择已取消，原草稿保留。')))
  listen(document, 'load', event => { if (event.target?.matches?.('gv-message-entry img')) scheduleScan() }, true)
  // Check only the URL each second; rendered message scans remain event driven.
  let lastMaintenance = Date.now()
  const pollTimer = setInterval(() => { checkNavigation(); if (Date.now() - lastMaintenance >= 10000) { lastMaintenance = Date.now(); scheduleScan() } }, 1000)
  listen(window, 'pagehide', event => {
    dispose()
    // BFCache resumes a document without running its preload/content script
    // again. Reinstall the same isolated guard before the restored page is used.
    if (event.persisted) {
      restoreListener = () => { restoreListener = null; installGoogleVoiceRuntime({ sendRequest, subscribe }) }
      window.addEventListener('pageshow', restoreListener, { once: true })
    }
  })
  scheduleScan()

  const unsubscribe = subscribe?.((message, reply = () => {}) => {
    if (disposed || message?.v !== 1) return
    if (message.type === 'voice.connection-changed') {
      invalidate(); return
    }
    if (message.type === 'selection.open' && validId(message.id)) { pending = { id: message.id, ticket: documentTicket }; reply({ ticket: documentTicket }); return }
    if (message.type === 'selection.begin' && validId(message.id) && typeof message.key === 'string' && /^[a-f0-9]{64}$/.test(message.key)) {
      if (!pending || pending.id !== message.id) { reply({ cancelled: true }); return }
      if (!logicalIds.has(message.key) && logicalIds.size < 128) logicalIds.set(message.key, crypto.randomUUID())
      reply({ ticket: pending.ticket, logicalId: logicalIds.get(message.key) }); return
    }
    if (message.type !== 'selection.result' || !pending || message.id !== pending.id || message.ticket !== pending.ticket) return
    pending = null
    const value = typeof message.text === 'string' ? message.text : message.error
    if (typeof value !== 'string' || Array.from(value).length > 8000) return
    showPanel(message.error ? 'HelloDog · 翻译未完成' : 'HelloDog · 选中文字翻译', value, [], '仅预览，不会自动填写或发送。发送保护仅适用于已识别的纯文本短信编辑器。')
  })
  function dispose() {
    if (restoreListener) { window.removeEventListener('pageshow', restoreListener); restoreListener = null }
    if (disposed) return
    disposed = true; invalidate(); clearTimeout(scanTimer); clearInterval(pollTimer)
    observer.disconnect(); adapter.dispose(); bar?.remove(); bar = null
    for (const remove of removers.splice(0)) remove()
    unsubscribe?.(); logicalIds.clear()
  }
  return { dispose, invalidate }
}
