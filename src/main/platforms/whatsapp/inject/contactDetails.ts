export function parseWhatsAppPresence(input: string, english = false): { kind: string; text: string } | undefined {
  const text = String(input || '').replace(/[\u200e\u200f]/g, '').replace(/\s+/g, ' ').trim()
  if (/^(?:typing|正在输入|正在輸入)[.…\s]*$/i.test(text)) return { kind: 'typing', text: english ? 'Typing…' : '正在输入…' }
  if (/^(?:recording (?:audio|a voice message)|正在录音|正在錄音)[.…\s]*$/i.test(text)) return { kind: 'recording', text: english ? 'Recording audio…' : '正在录音…' }
  if (/^(?:online|在线|在線)$/i.test(text)) return { kind: 'online', text: english ? 'Online' : '在线' }
  if (/^(?:last seen\b|最后上线|上次上线|最後上線|上次上線|上次在线)/i.test(text) && text.length <= 180) {
    return { kind: 'last-seen', text: !english ? text.replace(/^last seen\s*/i, '最后上线：').replace(/\btoday at\b/i, '今天').replace(/\byesterday at\b/i, '昨天') : text }
  }
  return undefined
}

function installWhatsAppContactDetails(parsePresence: typeof parseWhatsAppPresence) {
  const win = window as any
  if (win.__HD_CONTACT_DETAILS__) return
  win.__HD_CONTACT_DETAILS__ = true
  let state: any, dialog: HTMLDialogElement | undefined, dialogOwner: any, timer: ReturnType<typeof setTimeout> | undefined
  let english = false, selection: any, opening: any, synced = false, lastPeer = '', disposed = false
  const listStates = new Map<HTMLElement, any>(), learned = new Map<string, string>()
  const api = () => win.realtimeTranslator
  const ui = (zh: string, en: string) => english ? en : zh
  const nativeText = (node: Element) => { const copy = node.cloneNode(true) as Element; copy.querySelectorAll('[data-rt-ui]').forEach(el => el.remove()); return copy.textContent || '' }
  const titleNode = (container: Element) => Array.from(container.querySelectorAll<HTMLElement>('[data-testid="conversation-info-header-chat-title"], [data-testid="cell-frame-title"] span[title], span[title][dir="auto"], span[title]'))
    .find(el => !el.closest('[data-rt-ui]') && !parsePresence(el.getAttribute('title') || nativeText(el)))
  const nameOf = (title: Element) => (title.getAttribute('title') || nativeText(title)).trim()
  const parsePeer = (raw: string | null) => {
    const value = String(raw || '').replace(/^peer:/, '')
    const jid = value.match(/^(?:true|false)_([^_]+@[^_]+)_/)?.[1] || value
    return /^[a-zA-Z0-9.-]{1,160}@(c\.us|s\.whatsapp\.net|g\.us|lid)$/.test(jid) ? 'peer:' + jid : ''
  }
  const peerKey = () => {
    const values = new Set<string>()
    for (const el of document.querySelectorAll('#main [data-id]')) {
      if (el.closest('[data-rt-ui], blockquote, [data-testid*="quoted"]')) continue
      const match = (el.getAttribute('data-id') || '').match(/^(?:true|false)_([^_]+@[^_]+)_/)
      const peer = match && parsePeer(match[1]); if (peer) values.add(peer)
    }
    return values.size === 1 ? [...values][0] : ''
  }
  const rowNodes = (row: HTMLElement) => {
    const nodes = [row]
    for (let node: HTMLElement | null = titleNode(row) || null; node && node !== row; node = node.parentElement) nodes.push(node)
    return nodes
  }
  // Only identity attributes on the row/title ancestry count. A phone link or
  // sender JID inside the last-message preview must never identify the chat.
  const directPeer = (row: HTMLElement) => {
    const peers = new Set<string>()
    for (const node of rowNodes(row)) for (const attr of ['data-jid', 'data-chat-id', 'data-contact-id', 'data-id']) {
      const peer = parsePeer(node.getAttribute(attr)); if (peer) peers.add(peer)
    }
    return { peer: peers.size === 1 ? [...peers][0] : '', ambiguous: peers.size > 1 }
  }
  const rowKey = (row: HTMLElement) => {
    for (const node of rowNodes(row)) for (const attr of ['data-chat-id', 'data-row-key', 'data-id']) {
      const value = node.getAttribute(attr)
      // Numeric/index-shaped keys belong to a virtual slot, not a contact.
      if (value && value.length <= 240 && !/^(?:row[-_:]?)?\d+$/i.test(value)) return attr + ':' + value
    }
    return ''
  }
  const selected = (row: HTMLElement) => row.matches('[aria-selected="true"],[aria-current="true"],[data-selected="true"]')
    || Boolean(row.querySelector('[aria-selected="true"],[aria-current="true"],[data-selected="true"]'))
  const listPeer = (row: HTMLElement) => {
    const direct = directPeer(row)
    if (direct.ambiguous) return ''
    if (direct.peer) return direct.peer
    const key = rowKey(row)
    if (key && learned.has(key)) return learned.get(key)!
    return selection?.row === row && (selected(row) || selection.explicitNavigation) && selection.boundPeer === peerKey() ? selection.boundPeer || '' : ''
  }
  const rows = () => {
    const found = new Set<HTMLElement>()
    for (const node of document.querySelectorAll<HTMLElement>('#pane-side [role="row"], #pane-side [role="listitem"], #side [data-testid="cell-frame-container"], [data-testid="chat-list"] [role="row"], [data-testid="archived-chats"] [role="row"]')) {
      const row = node.closest<HTMLElement>('[role="row"],[role="listitem"]') || node
      if (!row.closest('#main,[data-rt-ui]') && titleNode(row)) found.add(row)
    }
    return [...found]
  }
  const close = () => { dialog?.remove(); dialog = undefined; dialogOwner = undefined }
  const ownedStyle = (view: any, node: HTMLElement, property: string, value: string) => {
    view.styles.push({ node, property, old: node.style.getPropertyValue(property), priority: node.style.getPropertyPriority(property), value })
    node.style.setProperty(property, value)
  }
  const remove = (view: any) => {
    if (!view) return
    if (view.retryTimer) clearTimeout(view.retryTimer)
    if (view.readTimer) clearTimeout(view.readTimer)
    view.readVersion = (view.readVersion || 0) + 1
    if (dialogOwner === view) close()
    view.root.remove()
    view.sources?.forEach((node: Element) => node.removeAttribute('data-hd-presence-source'))
    for (const saved of view.styles) if (saved.node.style.getPropertyValue(saved.property) === saved.value) {
      if (saved.old) saved.node.style.setProperty(saved.property, saved.old, saved.priority)
      else saved.node.style.removeProperty(saved.property)
    }
  }
  const resetHeader = () => { remove(state); state = undefined }
  const allViews = () => [...listStates.values(), ...(state ? [state] : [])]
  const current = (view: any) => view.kind === 'header'
    ? state === view && view.header.isConnected && peerKey() === view.peer
    : listStates.get(view.row) === view && view.row.isConnected && listPeer(view.row) === view.peer && rowKey(view.row) === view.key
  const renderNote = (view: any) => {
    const text = opening && opening.row === view.row ? ui('正在打开聊天…', 'Opening conversation…')
      : view.error ? view.value.text || ui('重试备注', 'Retry note') : view.value.text || ui('＋联系人备注', '+ Contact note')
    if (view.note.textContent !== text) view.note.textContent = text
    view.note.disabled = view.loading || view.kind === 'header' && !view.peer
    view.note.title = view.error || view.value.text || (view.peer
      ? ui('仅保存在此电脑，与应用备注独立', 'Saved on this computer, separate from the account note')
      : view.kind === 'list' ? ui('打开此聊天后添加备注', 'Open this conversation to add a note')
        : ui('等待聊天记录加载后可添加备注', 'Load the conversation history to add a note'))
    view.note.setAttribute('aria-label', ui('编辑 ', 'Edit note for ') + view.name + ui(' 的联系人备注', ''))
    view.note.setAttribute('data-hd-note-peer', view.peer || '')
  }
  const updateNote = (peer: string, value: any) => {
    if (!value || typeof value.text !== 'string' || value.text.length > 500 || !Number.isSafeInteger(value.revision) || value.revision < 0) return
    for (const view of allViews()) if (view.peer === peer && current(view) && value.revision >= view.value.revision) {
      view.value = { text: value.text, revision: value.revision }; view.loading = false; view.error = ''; view.retries = 0
      view.readVersion = (view.readVersion || 0) + 1
      if (view.readTimer) { clearTimeout(view.readTimer); view.readTimer = undefined }
      if (view.retryTimer) { clearTimeout(view.retryTimer); view.retryTimer = undefined }
      renderNote(view)
    }
  }
  const load = (view: any, editAfter = false) => {
    if (!view.peer) { view.loading = false; renderNote(view); return }
    if (view.loading) return
    if (view.retryTimer) { clearTimeout(view.retryTimer); view.retryTimer = undefined }
    const version = view.readVersion = (view.readVersion || 0) + 1
    view.loading = true; renderNote(view)
    const valid = () => !disposed && current(view) && version === view.readVersion
    const failed = () => {
      if (!valid()) return
      view.readVersion++; clearTimeout(view.readTimer); view.readTimer = undefined
      view.loading = false; view.error = ui('备注读取失败，请点击重试。', 'Could not load the note. Click to retry.'); renderNote(view)
      const attempt = view.retries = (view.retries || 0) + 1
      if (attempt <= 3) view.retryTimer = setTimeout(() => { view.retryTimer = undefined; if (current(view)) load(view) }, 800 * 2 ** (attempt - 1))
    }
    view.readTimer = setTimeout(failed, 8000)
    Promise.resolve().then(() => api().getContactNote(view.peer)).then(value => {
      if (!valid()) return
      if (!value || typeof value.text !== 'string' || value.text.length > 500 || !Number.isSafeInteger(value.revision) || value.revision < 0) { failed(); return }
      clearTimeout(view.readTimer); view.readTimer = undefined
      updateNote(view.peer, value); view.loading = false; renderNote(view); schedule()
      if (editAfter && !view.error) edit(view)
    }, failed)
  }
  const edit = (snapshot: any) => {
    if (!snapshot?.peer || snapshot.loading || dialog || !current(snapshot)) return
    const peer = snapshot.peer, revision = snapshot.value.revision
    dialogOwner = snapshot
    dialog = document.createElement('dialog'); dialog.setAttribute('data-rt-ui', 'contact-note-editor')
    dialog.setAttribute('aria-label', ui('联系人备注', 'Contact note'))
    Object.assign(dialog.style, { width: 'min(420px, 85vw)', border: '1px solid #52605c', borderRadius: '12px', padding: '18px', color: '#eef3f1', background: '#202b27' })
    const form = document.createElement('form'), heading = document.createElement('h3'), help = document.createElement('p'), area = document.createElement('textarea'), error = document.createElement('p')
    heading.textContent = snapshot.name + ui(' · 联系人备注', ' · Contact note')
    help.textContent = ui('聊天列表和聊天顶部显示同一条备注。仅保存在此电脑，不发送给对方。清空后保存即可移除。', 'The same note appears in the chat list and conversation header. Saved on this computer and never sent to the contact. Clear and save to remove.')
    help.style.fontSize = '12px'; area.value = snapshot.value.text; area.maxLength = 500; area.rows = 4; area.setAttribute('aria-label', ui('联系人备注', 'Contact note'))
    Object.assign(area.style, { width: '100%', boxSizing: 'border-box', color: '#ff858d', background: '#131c18', padding: '8px', border: '1px solid #52605c', borderRadius: '6px' })
    error.setAttribute('role', 'status'); error.style.color = '#ff858d'
    const save = document.createElement('button'), cancel = document.createElement('button')
    save.type = 'submit'; save.textContent = ui('保存备注', 'Save note'); cancel.type = 'button'; cancel.textContent = ui('取消', 'Cancel'); cancel.onclick = close
    for (const button of [save, cancel]) Object.assign(button.style, { padding: '7px 16px', marginRight: '8px', borderRadius: '6px', cursor: 'pointer' })
    form.append(heading, help, area, error, save, cancel); dialog.append(form); document.body.append(dialog)
    form.onsubmit = async event => {
      event.preventDefault(); if (save.disabled) return
      save.disabled = true
      try {
        if (dialogOwner !== snapshot || !current(snapshot)) throw new Error(ui('联系人已切换，请重新打开备注。', 'The contact changed. Open the note again.'))
        const value = await api().saveContactNote(peer, area.value, revision)
        if (!value || typeof value.text !== 'string' || value.text.length > 500 || !Number.isSafeInteger(value.revision) || value.revision <= revision) throw new Error(ui('未能确认备注已保存，请保留输入并重试。', 'Could not confirm the saved note. Keep your draft and retry.'))
        updateNote(peer, value)
        if (dialogOwner === snapshot) close()
      } catch (e: any) {
        error.textContent = e?.message || ui('备注保存失败，请重试。', 'Could not save. Try again.'); save.disabled = false
        // A concurrent edit stays visible after reopening; never overwrite it.
        if (current(snapshot)) Promise.resolve().then(() => api().getContactNote(peer)).then(value => updateNote(peer, value), () => {})
      }
    }
    dialog.addEventListener('cancel', event => { event.preventDefault(); close() })
    dialog.showModal?.(); if (!dialog.open) dialog.setAttribute('open', '')
    area.focus()
  }
  const openFromList = (view: any) => {
    if (view.peer) { if (view.error) load(view, true); else edit(view); return }
    if (opening || dialog || !view.row.isConnected) return
    opening = { row: view.row, key: rowKey(view.row), title: view.title, name: view.name, wasSelected: selected(view.row), previousPeer: peerKey(), expires: Date.now() + 6000 }
    view.error = ''; renderNote(view)
    // This is only a navigation click. It never reads a title as an identity,
    // creates a provider request or sends a message.
    // WhatsApp also attaches navigation to descendants of the virtual row.
    // Start at the native title, so both nested and row handlers receive it.
    view.title.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    view.title.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }))
    view.title.click()
    schedule()
  }
  const mount = (view: any, title: HTMLElement, boundary: HTMLElement) => {
    let host = title.parentElement || boundary
    while (host !== boundary && host.parentElement && host.parentElement !== boundary) {
      const css = getComputedStyle(host)
      if ((css.display === 'flex' || css.display === 'inline-flex') && css.flexDirection === 'column'
        || host.getAttribute('data-testid') === 'cell-frame-main') break
      host = host.parentElement
    }
    let branch: Element = title
    while (branch.parentElement && branch.parentElement !== host) branch = branch.parentElement
    const layout = getComputedStyle(host)
    if ((layout.display === 'flex' || layout.display === 'inline-flex') && layout.flexDirection !== 'column') {
      ownedStyle(view, host, 'flex-wrap', 'wrap')
      view.root.style.flexBasis = '100%'
    } else if (view.kind === 'list' && layout.flexDirection === 'column') ownedStyle(view, host, 'gap', '0px')
    host.insertBefore(view.root, host !== boundary && branch.parentElement === host ? branch.nextSibling : null)
    view.host = host
  }
  const makeView = (kind: 'header' | 'list', parent: HTMLElement, title: HTMLElement, peer: string) => {
    const root = document.createElement('div'), note = document.createElement('button')
    root.setAttribute('data-rt-ui', kind === 'header' ? 'contact-details' : 'contact-list-note')
    Object.assign(root.style, { display: 'flex', flexDirection: 'column', minWidth: '0', maxWidth: '100%', gap: '1px', flexShrink: '0' })
    if (kind === 'list') Object.assign(root.style, { height: '14px', lineHeight: '14px' })
    note.type = 'button'
    Object.assign(note.style, { display: 'block', padding: '0', margin: '0', background: 'transparent', border: '0', color: '#ff858d', fontSize: kind === 'list' ? '11px' : '12px', lineHeight: kind === 'list' ? '14px' : '16px', textAlign: 'start', width: '100%', maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'pointer' })
    root.append(note)
    const view: any = { kind, title, peer, name: nameOf(title), key: kind === 'list' ? rowKey(parent) : '', root, note, styles: [], value: { text: '', revision: 0 }, loading: false }
    if (kind === 'list') view.row = parent; else view.header = parent
    for (const event of ['pointerdown', 'mousedown', 'mouseup', 'keydown']) note.addEventListener(event, e => e.stopPropagation())
    note.onclick = event => { event.preventDefault(); event.stopPropagation(); if (kind === 'list') openFromList(view); else if (view.error) load(view, true); else edit(view) }
    mount(view, title, parent)
    return view
  }
  const syncSelection = (items: HTMLElement[], peer: string, headerTitle?: HTMLElement) => {
    // Some native versions do not expose aria-selected. A requested navigation
    // may bind only after a new stable message JID arrives, never by name alone.
    const navigated = opening && peer && peer !== opening.previousPeer && items.includes(opening.row)
      && rowKey(opening.row) === opening.key && (opening.key || titleNode(opening.row) === opening.title)
      && titleNode(opening.row) && nameOf(titleNode(opening.row)!) === opening.name
    const preserved = selection?.explicitNavigation && selection.boundPeer === peer && items.includes(selection.row)
      && rowKey(selection.row) === selection.key && titleNode(selection.row) === selection.title && nameOf(selection.title) === selection.name
    const active = navigated ? [opening.row] : preserved ? [selection.row] : items.filter(selected)
    if (active.length !== 1) { selection = undefined; return }
    const row = active[0], key = rowKey(row)
    if (!selection || selection.row !== row || selection.key !== key) {
      selection = { row, key, title: titleNode(row), name: nameOf(titleNode(row)!), previousPeer: selection?.boundPeer || selection?.peerAtSelection || (synced ? lastPeer : ''), peerAtSelection: peer, boundPeer: '', explicitNavigation: Boolean(navigated) }
    }
    const title = titleNode(row)
    if (!peer || !title || !headerTitle || nameOf(title) !== nameOf(headerTitle) || directPeer(row).ambiguous) return
    // On switching rows, wait for a different stable message JID. This prevents
    // the previous chat's still-mounted messages from labeling a same-name row.
    const ready = !selection.previousPeer || peer !== selection.previousPeer || opening?.row === row && opening.wasSelected
      || directPeer(row).peer === peer || Boolean(key && learned.get(key) === peer)
    if (!ready || selection.boundPeer && selection.boundPeer !== peer) return
    if (key && learned.has(key) && learned.get(key) !== peer) return
    selection.boundPeer = peer
    if (key) { learned.set(key, peer); if (learned.size > 500) learned.delete(learned.keys().next().value!) }
  }
  const syncLists = (items: HTMLElement[]) => {
    const keep = new Set(items)
    for (const [row, view] of listStates) if (!keep.has(row) || !row.isConnected) { remove(view); listStates.delete(row) }
    for (const row of items) {
      const title = titleNode(row)!, peer = listPeer(row), key = rowKey(row)
      let view = listStates.get(row)
      if (!view || view.title !== title || view.peer !== peer || view.key !== key || view.name !== nameOf(title) || !view.root.isConnected) {
        remove(view); view = makeView('list', row, title, peer); listStates.set(row, view); load(view)
      }
    }
    if (opening) {
      const pending = opening, view = listStates.get(pending.row)
      if (!view || !pending.row.isConnected || rowKey(pending.row) !== pending.key || !pending.key && view.title !== pending.title || view.name !== pending.name || Date.now() > pending.expires) {
        opening = undefined
        if (view) { view.error = ui('未能确认联系人，请打开此聊天后重试备注。', 'Could not confirm the contact. Open this conversation, then retry the note.'); renderNote(view) }
      } else if ((selected(pending.row) || selection?.row === pending.row && selection.explicitNavigation) && view.peer && view.peer === peerKey() && !view.loading) {
        opening = undefined; renderNote(view); edit(view)
      }
    }
  }
  const syncHeader = (header: HTMLElement | null, title: HTMLElement | undefined, peer: string) => {
    if (!header || !title) { resetHeader(); return }
    if (!state || state.header !== header || state.title !== title || state.peer !== peer || state.name !== nameOf(title) || !state.root.isConnected) {
      resetHeader(); state = makeView('header', header, title, peer)
      state.sources = new Set<Element>()
      state.presence = document.createElement('div')
      state.presence.setAttribute('role', 'status'); state.presence.setAttribute('aria-live', 'polite'); state.presence.setAttribute('data-hd-presence', '')
      Object.assign(state.presence.style, { fontSize: '12px', lineHeight: '16px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' })
      state.root.append(state.presence); ownedStyle(state, header, 'min-height', '76px'); load(state)
    }
    let chosen: ReturnType<typeof parsePresence>
    const matches = new Set<Element>()
    state.sources.forEach((node: Element) => node.removeAttribute('data-hd-presence-source'))
    for (const node of header.querySelectorAll('span, [data-testid*="subtitle"], [data-testid*="typing"], [data-testid*="presence"]')) {
      if (node.closest('[data-rt-ui]') || node === title || node.contains(title)) continue
      let hidden = false
      for (let item: Element | null = node; item && item !== header; item = item.parentElement) {
        const css = getComputedStyle(item)
        if (item.hasAttribute('hidden') || item.getAttribute('aria-hidden') === 'true' || css.visibility === 'hidden' || css.display === 'none') { hidden = true; break }
      }
      if (hidden) continue
      const value = parsePresence(nativeText(node), english)
      if (!value) continue
      matches.add(node)
      if (!chosen || ['typing','recording'].includes(value.kind) || chosen.kind === 'last-seen' && value.kind === 'online') chosen = value
    }
    state.sources.forEach((node: Element) => { if (!matches.has(node)) node.removeAttribute('data-hd-presence-source') })
    matches.forEach(node => node.setAttribute('data-hd-presence-source', '')); state.sources = matches
    const text = navigator.onLine === false || document.visibilityState === 'hidden' ? '' : chosen?.text || ''
    if (state.presence.textContent !== text) state.presence.textContent = text
    const kind = text ? chosen?.kind || '' : ''
    if (state.presence.dataset.kind !== kind) state.presence.dataset.kind = kind
    state.presence.style.color = ['typing','recording','online'].includes(kind) ? 'var(--online, #4ac98b)' : 'var(--secondary, #9aa8a2)'
    state.presence.title = text
  }
  const sync = () => {
    if (disposed) return
    if (!api()?.getContactNote) { resetHeader(); for (const view of listStates.values()) remove(view); listStates.clear(); return }
    const header = document.querySelector<HTMLElement>('#main header'), title = header ? titleNode(header) : undefined, peer = peerKey(), items = rows()
    syncSelection(items, peer, title); syncLists(items); syncHeader(header, title, peer)
    lastPeer = peer; synced = true
    if (opening) schedule()
  }
  const style = document.createElement('style'); style.setAttribute('data-rt-ui', 'contact-style')
  style.textContent = '#main header [data-hd-presence-source]{display:none!important}[data-rt-ui="contact-note-editor"]::backdrop{background:#0009}[data-rt-ui="contact-list-note"] button:focus-visible,[data-rt-ui="contact-details"] button:focus-visible{outline:2px solid #ff858d;outline-offset:1px;border-radius:2px}'
  document.head.append(style)
  const schedule = () => { if (!disposed && !timer) timer = setTimeout(() => { timer = undefined; sync() }, 80) }
  const observer = new MutationObserver(changes => { if (changes.some(change => !(change.target instanceof Element ? change.target : change.target.parentElement)?.closest('[data-rt-ui]'))) schedule() })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ['hidden', 'aria-hidden', 'aria-selected', 'aria-current', 'data-selected', 'style', 'class', 'title', 'data-id', 'data-jid', 'data-chat-id', 'data-contact-id', 'data-row-key'] })
  const onScroll = (event: Event) => {
    const target = event.target as Element | null
    if (target?.closest?.('#pane-side,#side,[data-testid="chat-list"]') && selection && !selection.key) { selection.boundPeer = ''; selection.explicitNavigation = false; schedule() }
  }
  document.addEventListener('scroll', onScroll, true)
  const recover = () => {
    if (disposed) return
    schedule()
    if (document.visibilityState === 'hidden') return
    for (const view of allViews()) if (view.peer && view.error && !view.loading) { view.retries = 0; load(view) }
  }
  window.addEventListener('online', recover); window.addEventListener('focus', recover); window.addEventListener('offline', schedule); document.addEventListener('visibilitychange', recover)
  win.__HD_SYNC_CONTACT_DETAILS__ = sync
  window.addEventListener('pagehide', () => {
    disposed = true
    observer.disconnect(); if (timer) clearTimeout(timer); opening = undefined; close(); resetHeader()
    for (const view of listStates.values()) remove(view)
    listStates.clear(); learned.clear(); style.remove(); document.removeEventListener('scroll', onScroll, true)
    window.removeEventListener('online', recover); window.removeEventListener('focus', recover); window.removeEventListener('offline', schedule); document.removeEventListener('visibilitychange', recover)
  }, { once: true })
  if (api()?.getRuntimeSettings) Promise.resolve(api().getRuntimeSettings()).then(settings => {
    english = settings?.uiLanguage === 'en'; for (const view of allViews()) renderNote(view); schedule()
  }, () => {})
  sync()
}
// Some TS transforms retain function names through this local helper. Keep the
// serialized functions self-contained in both development and packaged builds.
export const whatsappContactScript = '(() => { const __name = fn => fn; (' + installWhatsAppContactDetails.toString() + ')(' + parseWhatsAppPresence.toString() + '); })();'
