export function parseWhatsAppPresence(input: string): { kind: string } | undefined {
  const text = String(input || '').replace(/[\u200e\u200f]/g, '').replace(/\s+/g, ' ').trim()
  if (/^(?:typing|正在输入|正在輸入)[.…\s]*$/i.test(text)) return { kind: 'typing' }
  if (/^(?:recording (?:audio|a voice message)|正在录音|正在錄音)[.…\s]*$/i.test(text)) return { kind: 'recording' }
  if (/^(?:online|在线|在線)$/i.test(text)) return { kind: 'online' }
  if (/^(?:last seen\b|最后上线|上次上线|最後上線|上次上線|上次在线)/i.test(text) && text.length <= 180) return { kind: 'last-seen' }
  return undefined
}

function installWhatsAppPresence(parsePresence: typeof parseWhatsAppPresence) {
  const win = window as any
  if (win.__HD_PRESENCE__) return
  win.__HD_PRESENCE__ = true
  const owned = new Map<HTMLElement, { color: string; priority: string; applied: string }>()
  const writtenStyles = new WeakMap<HTMLElement, string>()
  let timer: ReturnType<typeof setTimeout> | undefined, disposed = false
  const restore = (node: HTMLElement) => {
    const saved = owned.get(node)
    if (!saved) return
    if (node.style.color === saved.applied) {
      if (saved.color) node.style.setProperty('color', saved.color, saved.priority)
      else node.style.removeProperty('color')
    }
    node.removeAttribute('data-hd-presence-kind'); owned.delete(node)
  }
  const visible = (node: Element, boundary: Element) => {
    for (let item: Element | null = node; item; item = item.parentElement) {
      const style = getComputedStyle(item)
      if (item.hasAttribute('hidden') || item.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden') return false
      if (item === boundary) break
    }
    return true
  }
  const sync = () => {
    if (disposed) return
    const header = document.querySelector<HTMLElement>('#main header'), keep = new Set<HTMLElement>()
    if (header && visible(header, document.documentElement)) {
      const title = header.querySelector('[data-testid="conversation-info-header-chat-title"], span[title][dir="auto"], span[title]')
      const candidates = [...header.querySelectorAll<HTMLElement>('span, div, p, [data-testid*="subtitle"], [data-testid*="typing"], [data-testid*="presence"]')]
        .filter(node => node !== title && !node.contains(title) && !node.closest('[data-rt-ui], button, [role="button"]') && visible(node, header))
        .map(node => ({ node, value: parsePresence(node.textContent || '') }))
        .filter(item => item.value)
      for (const { node, value } of candidates) {
        // Enhance the deepest native status only. Never copy/hide it or change
        // the header height: React owns status text and WhatsApp owns privacy.
        if (candidates.some(other => other.node !== node && node.contains(other.node))) continue
        keep.add(node)
        const applied = value!.kind === 'last-seen' ? 'var(--secondary, #9aa8a2)' : 'var(--online, #4ac98b)'
        const previous = owned.get(node)
        if (!previous || node.style.color !== previous.applied) owned.set(node, { color: node.style.color, priority: node.style.getPropertyPriority('color'), applied })
        else previous.applied = applied
        if (node.style.color !== applied) { node.style.setProperty('color', applied); writtenStyles.set(node, node.style.cssText) }
        if (node.getAttribute('data-hd-presence-kind') !== value!.kind) node.setAttribute('data-hd-presence-kind', value!.kind)
      }
    }
    for (const node of owned.keys()) if (!keep.has(node)) restore(node)
  }
  const schedule = () => { if (!disposed && !timer) timer = setTimeout(() => { timer = undefined; sync() }, 80) }
  // Text/identity changes in the conversation header matter; message bodies,
  // list previews and the retired note feature do not trigger status scans.
  const observer = new MutationObserver(changes => {
    if (changes.some(change => {
      const node = change.target instanceof Element ? change.target : change.target.parentElement
      if (!node || node.closest('[data-rt-ui]')) return false
      if (change.type === 'attributes' && change.attributeName === 'style' && writtenStyles.get(node as HTMLElement) === (node as HTMLElement).style.cssText) return false
      return Boolean(node.closest('#main header') || node.matches('#main') || change.type === 'childList' && [...change.addedNodes, ...change.removedNodes].some(item => item instanceof Element && (item.matches('#main, header') || item.querySelector('#main, header'))))
    })) schedule()
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'style', 'class', 'title'] })
  document.addEventListener('visibilitychange', schedule)
  window.addEventListener('focus', schedule)
  const dispose = () => {
    disposed = true; observer.disconnect(); if (timer) clearTimeout(timer)
    for (const node of owned.keys()) restore(node)
    document.removeEventListener('visibilitychange', schedule); window.removeEventListener('focus', schedule)
    delete win.__HD_SYNC_PRESENCE__; delete win.__HD_PRESENCE__
  }
  window.addEventListener('pagehide', dispose, { once: true })
  win.__HD_SYNC_PRESENCE__ = sync
  sync()
}

export const whatsappPresenceScript = '(() => { const __name = fn => fn; (' + installWhatsAppPresence.toString() + ')(' + parseWhatsAppPresence.toString() + '); })();'
