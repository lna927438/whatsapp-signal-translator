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
  let state: any, generation = 0, dialog: HTMLDialogElement | undefined, timer: ReturnType<typeof setTimeout> | undefined
  const api = () => win.realtimeTranslator
  const ui = (zh: string, en: string) => state?.english ? en : zh
  const peerKey = () => {
    const values = new Set<string>()
    for (const el of document.querySelectorAll('#main [data-id]')) {
      const match = (el.getAttribute('data-id') || '').match(/^(?:true|false)_([^_]+@[^_]+)_/)
      if (match && !el.closest('[data-rt-ui], blockquote, [data-testid*="quoted"]')) values.add('peer:' + match[1])
    }
    return values.size === 1 ? [...values][0] : ''
  }
  const nativeText = (node: Element) => { const copy = node.cloneNode(true) as Element; copy.querySelectorAll('[data-rt-ui]').forEach(el => el.remove()); return copy.textContent || '' }
  const titleNode = (header: Element) => Array.from(header.querySelectorAll<HTMLElement>('[data-testid="conversation-info-header-chat-title"], span[title][dir="auto"], span[title]'))
    .find(el => !el.closest('[data-rt-ui]') && !parsePresence(el.getAttribute('title') || nativeText(el)))
  const close = () => { dialog?.remove(); dialog = undefined }
  const reset = () => {
    generation++; close()
    if (!state) return
    state.root.remove()
    state.sources.forEach((el: Element) => el.removeAttribute('data-hd-presence-source'))
    if (state.header.style.minHeight === '76px') state.header.style.minHeight = state.minHeight
    state = undefined
  }
  const renderNote = () => {
    if (!state) return
    state.note.textContent = state.value.text || ui('＋联系人备注', '+ Contact note')
    state.note.title = state.value.text || ui('仅保存在此电脑，与应用备注独立', 'Saved on this computer, separate from the account note')
    state.note.disabled = !state.peer || state.loading
    state.note.setAttribute('aria-label', ui('编辑联系人备注', 'Edit contact note'))
    if (!state.peer) state.note.title = ui('等待聊天记录加载后可添加备注', 'Load the conversation history to add a note')
  }
  const edit = () => {
    if (!state?.peer || state.loading || dialog) return
    const snapshot = state, peer = state.peer, revision = state.value.revision
    dialog = document.createElement('dialog'); dialog.setAttribute('data-rt-ui', 'contact-note-editor')
    dialog.setAttribute('aria-label', ui('联系人备注', 'Contact note'))
    Object.assign(dialog.style, { width: 'min(420px, 85vw)', border: '1px solid #52605c', borderRadius: '12px', padding: '18px', color: '#eef3f1', background: '#202b27' })
    const form = document.createElement('form'), heading = document.createElement('h3'), help = document.createElement('p'), area = document.createElement('textarea'), error = document.createElement('p')
    heading.textContent = ui('联系人备注', 'Contact note')
    help.textContent = ui('仅保存在此电脑，不发送给对方。清空后保存即可移除。', 'Saved on this computer and never sent to the contact. Clear and save to remove.')
    help.style.fontSize = '12px'; area.value = snapshot.value.text; area.maxLength = 500; area.rows = 4; area.setAttribute('aria-label', heading.textContent)
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
        if (snapshot !== state || peer !== peerKey()) throw new Error(ui('聊天已切换，请重新打开备注。', 'The conversation changed. Open the note again.'))
        const value = await api().saveContactNote(peer, area.value, revision)
        if (state === snapshot) { state.value = value; renderNote(); close() }
      } catch (e: any) { error.textContent = e?.message || ui('备注保存失败，请重试。', 'Could not save. Try again.'); save.disabled = false }
    }
    dialog.addEventListener('cancel', event => { event.preventDefault(); close() })
    dialog.showModal?.(); if (!dialog.open) dialog.setAttribute('open', '')
    area.focus()
  }
  const sync = () => {
    const header = document.querySelector<HTMLElement>('#main header'), peer = peerKey(), title = header && titleNode(header)
    if (!header || !title || !api()?.getContactNote) { reset(); return }
    const name = title.getAttribute('title') || nativeText(title)
    if (!state || state.header !== header || state.title !== title || state.peer !== peer || state.name !== name) {
      reset()
      const root = document.createElement('div'), note = document.createElement('button'), presence = document.createElement('div')
      root.setAttribute('data-rt-ui', 'contact-details')
      Object.assign(root.style, { display: 'flex', flexDirection: 'column', minWidth: '0', maxWidth: '100%', gap: '1px' })
      note.type = 'button'; note.onclick = edit
      Object.assign(note.style, { display: 'block', padding: '0', background: 'transparent', border: '0', color: '#ff858d', fontSize: '12px', lineHeight: '16px', textAlign: 'start', maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'pointer' })
      presence.setAttribute('role', 'status'); presence.setAttribute('aria-live', 'polite'); presence.setAttribute('data-hd-presence', '')
      Object.assign(presence.style, { fontSize: '12px', lineHeight: '16px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' })
      root.append(note, presence)
      let column = title.parentElement || header
      const layout = getComputedStyle(column)
      // Native title rows may also contain verification/mute icons. Keep that
      // row intact and insert details underneath it in the enclosing column.
      if (column !== header && column.parentElement !== header && column.parentElement
        && (layout.display === 'flex' || layout.display === 'inline-flex') && layout.flexDirection === 'row') column = column.parentElement
      column.appendChild(root)
      state = { header, title, peer, name, root, note, presence, value: { text: '', revision: 0 }, loading: Boolean(peer), sources: new Set<Element>(), minHeight: header.style.minHeight, english: false }
      header.style.minHeight = '76px'; renderNote()
      const snapshot = state, version = generation
      if (peer) void api().getContactNote(peer).then((value: any) => { if (state === snapshot && generation === version) { state.value = value; state.loading = false; renderNote() } }, () => { if (state === snapshot) { state.loading = false; renderNote() } })
      void api().getRuntimeSettings?.().then((settings: any) => { if (state === snapshot) { state.english = settings?.uiLanguage === 'en'; renderNote() } }).catch(() => {})
    }
    let chosen: ReturnType<typeof parsePresence>
    const matches = new Set<Element>()
    // Inspect WhatsApp's current visibility without our presentation mask.
    // Both changes happen in one task, so the native line never flashes.
    state.sources.forEach((node: Element) => node.removeAttribute('data-hd-presence-source'))
    for (const node of header.querySelectorAll('span, [data-testid*="subtitle"], [data-testid*="typing"], [data-testid*="presence"]')) {
      if (node.closest('[data-rt-ui]') || node === title || node.contains(title)) continue
      let hidden = false
      for (let item: Element | null = node; item && item !== header; item = item.parentElement) {
        const css = getComputedStyle(item)
        if (item.hasAttribute('hidden') || item.getAttribute('aria-hidden') === 'true' || css.visibility === 'hidden'
          || css.display === 'none' && !item.hasAttribute('data-hd-presence-source')) { hidden = true; break }
      }
      if (hidden) continue
      const value = parsePresence(nativeText(node), state.english)
      if (!value) continue
      matches.add(node)
      if (!chosen || ['typing','recording'].includes(value.kind) || chosen.kind === 'last-seen' && value.kind === 'online') chosen = value
    }
    state.sources.forEach((node: Element) => { if (!matches.has(node)) node.removeAttribute('data-hd-presence-source') })
    matches.forEach(node => { if (!node.hasAttribute('data-hd-presence-source')) node.setAttribute('data-hd-presence-source', '') })
    state.sources = matches
    // Display only the state exposed by WhatsApp. Hidden/offline is not "offline".
    const text = navigator.onLine === false || document.visibilityState === 'hidden' ? '' : chosen?.text || ''
    if (state.presence.textContent !== text) state.presence.textContent = text
    const kind = text ? chosen?.kind || '' : ''
    if (state.presence.dataset.kind !== kind) state.presence.dataset.kind = kind
    state.presence.style.color = ['typing','recording','online'].includes(kind) ? 'var(--online, #4ac98b)' : 'var(--secondary, #9aa8a2)'
    state.presence.title = text
  }
  const style = document.createElement('style'); style.setAttribute('data-rt-ui', 'contact-style')
  style.textContent = '#main header [data-hd-presence-source]{display:none!important}[data-rt-ui="contact-note-editor"]::backdrop{background:#0009}'
  document.head.append(style)
  const schedule = () => { if (!timer) timer = setTimeout(() => { timer = undefined; sync() }, 80) }
  const observer = new MutationObserver(changes => { if (changes.some(change => !(change.target instanceof Element ? change.target : change.target.parentElement)?.closest('[data-rt-ui]'))) schedule() })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'style', 'class', 'title', 'data-id'] })
  window.addEventListener('online', schedule); window.addEventListener('offline', schedule); document.addEventListener('visibilitychange', schedule)
  win.__HD_SYNC_CONTACT_DETAILS__ = sync
  window.addEventListener('pagehide', () => { observer.disconnect(); if (timer) clearTimeout(timer); reset(); style.remove() }, { once: true })
  sync()
}
// Some TS transforms retain function names through this local helper. Keep the
// serialized functions self-contained in both development and packaged builds.
export const whatsappContactScript = '(() => { const __name = fn => fn; (' + installWhatsAppContactDetails.toString() + ')(' + parseWhatsAppPresence.toString() + '); })();'
