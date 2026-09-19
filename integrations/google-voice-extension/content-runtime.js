(() => {
  'use strict'
  if (window !== window.top || location.origin !== 'https://voice.google.com') return
  const documentTicket = crypto.randomUUID(), logicalIds = new Map(), messages = new Map(), elementKeys = new WeakMap()
  const adapter = new GoogleVoiceDomAdapter(document, location)
  let panel, pending, bar, guard, guardConversation, runtimeStatus, statusAt = 0, scanTimer, scanBusy = false, epoch = 0, autoBusy = false

  function showPanel(title, value, actions = [], note = '请核对内容。只有点击“确认发送”才会提交短信。') {
    panel?.remove(); panel = document.createElement('div')
    panel.style.cssText = 'position:fixed;bottom:24px;right:24px;width:min(440px,90vw);z-index:2147483647;'
    const shadow = panel.attachShadow({ mode: 'closed' }), style = document.createElement('style')
    style.textContent = ':host{all:initial}section{font:14px/1.5 system-ui;color:#eef6f2;background:#19232a;border:1px solid #48625a;border-radius:12px;padding:18px;box-shadow:0 8px 32px #0006}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}button{background:#32473f;color:#fff;border:0;border-radius:6px;padding:7px 10px;cursor:pointer}button:disabled{opacity:.5}textarea{box-sizing:border-box;width:100%;min-height:110px;max-height:35vh;background:#111a20;color:#eef6f2;border:1px solid #48625a;border-radius:6px;padding:10px;resize:vertical}p{color:#b9c9c3;font-size:12px;margin-bottom:0}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}'
    const section = document.createElement('section'), header = document.createElement('header'), heading = document.createElement('strong'), close = document.createElement('button')
    heading.textContent = title; close.textContent = '关闭'; close.type = 'button'; const currentPanel = panel; close.onclick = () => currentPanel.remove()
    const text = document.createElement('textarea'); text.readOnly = true; text.value = value; text.setAttribute('aria-label', '翻译结果'); text.onclick = () => text.select()
    const footer = document.createElement('p'); footer.textContent = note
    const controls = document.createElement('div'); controls.className = 'actions'
    for (const action of actions) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = action.label
      button.onclick = () => { for (const child of controls.children) child.disabled = true; Promise.resolve().then(action.run).catch(showError).finally(() => { for (const child of controls.children) child.disabled = false }) }
      controls.append(button)
    }
    header.append(heading, close); section.append(header, text, controls, footer); shadow.append(style, section)
    for (const type of ['keydown', 'keyup', 'keypress', 'click', 'pointerdown', 'beforeinput']) section.addEventListener(type, event => event.stopPropagation())
    ;(document.body || document.documentElement).append(panel)
  }
  async function request(type, payload) {
    const answer = await chrome.runtime.sendMessage({ v: 1, type: 'voice.' + type, ...(payload ? { payload } : {}) })
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
    if (!await adapter.refresh()) throw new Error('当前短信会话或附件编辑器尚未支持，已阻止此发送操作。')
    const snapshot = adapter.snapshot()
    if (!guard || guardConversation !== snapshot.conversationId) { guard = new SendGuard(adapter, bridge); guardConversation = snapshot.conversationId }
    const active = guard
    showPanel('HelloDog · 正在准备预览', '正在核对连接、此前发送结果及翻译。请保留草稿。', [], '此时尚未发送短信。')
    const preview = await active.prepare()
    if (guard !== active || adapter.snapshot()?.conversationId !== snapshot.conversationId) throw new Error('会话已变化，译文未发送。')
    showPanel(preview.untranslated ? 'HelloDog · 原文无需翻译' : 'HelloDog · 发送前预览', preview.text, [{ label: '确认发送', run: async () => {
      await active.confirm()
      showPanel('HelloDog · 已提交', '已执行一次原站发送操作。送达情况以 Google Voice 官方聊天为准。', [], '可以继续编辑其他短信。同文再次发送前需要先核对此次结果；不会自动重发。')
    } }])
  }
  // Installed before the app's document handlers. Unknown new-recipient and
  // attachment surfaces using these known controls are blocked, not guessed.
  for (const type of ['keydown', 'keyup', 'keypress', 'beforeinput', 'click', 'submit', 'paste', 'drop']) window.addEventListener(type, event => {
    const intent = adapter.eventIntent(event)
    if (!intent) return
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation()
    if (intent === 'attachment') { showError(new Error('当前仅支持已核实的纯文本短信，图片草稿发送尚未验证。')); return }
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
    bar.firstChild.textContent = supported ? runtimeStatus?.connected ? '文本发送先预览 · 不自动重发' : '发送前需连接 HelloDog' : '当前编辑器未识别 · 已阻止已知发送入口'
    bar.lastChild.disabled = !supported
  }
  async function translateMessage(item, manual) {
    if (!adapter.validMessage(item)) return
    const key = item.conversationId + ':' + item.id, cached = messages.get(key)
    if (cached?.work || cached?.text) return cached?.text
    const state = cached || {}; messages.set(key, state); const startedEpoch = epoch
    state.work = true; state.error = false; renderMessageViews(state)
    try {
      const value = translatedValue(await bridge.translate({ id: item.id, conversationId: item.conversationId, direction: 'incoming', text: item.text, manual }))
      if (epoch !== startedEpoch) return
      state.text = value.text
    } catch (error) { if (epoch === startedEpoch) { state.error = error?.code !== 'busy'; state.retryAfter = error?.code === 'busy' ? Date.now() + 2000 : 0; if (manual) showError(error) } }
    finally { state.work = false; renderMessageViews(state); scheduleScan() }
  }
  function removeMessageViews() { for (const state of messages.values()) for (const view of state.views?.values() || []) view.node.remove(); messages.clear() }
  function renderMessageViews(state) {
    for (const [element, view] of state.views || []) {
      if (!element.isConnected) { state.views.delete(element); continue }
      if (!adapter.validMessage(view.item)) continue
      view.node.style.display = runtimeStatus?.translationsVisible === false ? 'none' : ''
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
    if (!oldView?.node.isConnected || oldView.node.parentElement !== item.element) {
      oldView?.node.remove(); const node = document.createElement('div'); node.dataset.hellodogVoice = 'translation'
      node.style.cssText = 'font:13px/1.5 system-ui;color:#8abdaa;margin:5px 16px 9px;white-space:pre-wrap;overflow-wrap:anywhere;'
      const button = document.createElement('button'); button.type = 'button'; button.textContent = state.error ? '重试翻译' : '翻译'
      button.style.cssText = 'font:12px system-ui;color:#3c8064;background:transparent;border:0;cursor:pointer;padding:3px 0;'
      button.onclick = () => { void translateMessage(item, true) }
      node.append(button); item.element.append(node); state.views.set(item.element, { node, button, item })
    } else oldView.item = item
    renderMessageViews(state)
    return state
  }
  async function scan() {
    scanTimer = null
    if (scanBusy) return
    scanBusy = true
    try {
      const supported = await adapter.refresh(); toolbar(supported)
      if (!supported) return
      if (Date.now() - statusAt > 10000 && !autoBusy && !['preparing', 'authorizing'].includes(guard?.state)) {
        statusAt = Date.now()
        try {
          const next = await bridge.status()
          if (runtimeStatus?.localLanguage !== next.localLanguage) { epoch++; removeMessageViews() }
          runtimeStatus = next
        } catch { runtimeStatus = null }
        toolbar(true)
      }
      const items = await adapter.messages()
      let nextAuto
      for (const item of items) {
        if (!adapter.validMessage(item)) continue
        const state = addMessage(item)
        if (!nextAuto && state && !state.work && !state.text && !state.error && (!state.retryAfter || Date.now() >= state.retryAfter) && item.automatic && adapter.visibleMessage(item)) nextAuto = item
      }
      if (nextAuto && runtimeStatus?.connected && runtimeStatus.receiveAutoTranslate && runtimeStatus.translationsVisible !== false && runtimeStatus.historyMode === 'visible' && document.visibilityState === 'visible' && !autoBusy && !['preparing', 'authorizing', 'preview'].includes(guard?.state)) {
        autoBusy = true
        try { await translateMessage(nextAuto, false) } finally { autoBusy = false; scheduleScan() }
      }
    } finally { scanBusy = false }
  }
  function scheduleScan() { if (!scanTimer) scanTimer = setTimeout(() => { void scan().catch(() => {}) }, 250) }
  new MutationObserver(changes => { if (changes.some(change => !change.target.closest?.('[data-hellodog-voice]'))) scheduleScan() }).observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'disabled', 'aria-readonly'] })
  window.addEventListener('popstate', scheduleScan); window.addEventListener('scroll', scheduleScan, true); document.addEventListener('visibilitychange', scheduleScan)
  setInterval(scheduleScan, 10000); scheduleScan()

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || message?.v !== 1) return
    if (message.type === 'voice.connection-changed') {
      epoch++; runtimeStatus = null; statusAt = 0; guard = null; guardConversation = null; removeMessageViews(); panel?.remove(); scheduleScan(); return
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
})()
