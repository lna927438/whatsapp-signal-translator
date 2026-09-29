/** Official navigation badges and exact Messages document titles were observed
 * read-only on 2026-09-20. The embedded narrow layout can hide the whole drawer;
 * its title remains the official count. Never infer counts from message rows. */
export function readGoogleVoiceUnread(document: Document): number | null {
  const view = document.defaultView
  if (!view) return null
  const navigation = [...document.querySelectorAll('mat-nav-list a[role="tab"][gv-test-id="sidenav-messages"]')]
  if (navigation.some(link => link.closest('[aria-busy="true"]'))) return null
  const links = navigation.filter(link => {
    if (link.closest('[hidden],[inert],[aria-hidden="true"]')) return false
    const box = link.getBoundingClientRect(), style = view.getComputedStyle(link)
    return box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0 &&
      box.left < view.innerWidth && box.top < view.innerHeight && style.display !== 'none' && style.visibility === 'visible'
  })
  if (!links.length) {
    const title = document.title.trim()
    if (title === 'Voice - Messages') return 0
    const match = /^Voice - \(([1-9]\d{0,4})\) Messages$/.exec(title)
    return match ? Number(match[1]) : null
  }
  if (links.length !== 1) return null
  const badges = links[0].querySelectorAll('mat-icon.mat-badge')
  if (badges.length !== 1) return null
  const badge = badges[0]
  if (badge.classList.contains('mat-badge-hidden')) return 0
  const values = badge.querySelectorAll('.mat-badge-content')
  if (values.length !== 1 || !values[0].classList.contains('mat-badge-active') || !values[0].getClientRects().length) return null
  const style = document.defaultView?.getComputedStyle(values[0])
  if (!style || style.display === 'none' || style.visibility !== 'visible') return null
  const value = values[0].textContent?.trim() || ''
  return /^[1-9]\d{0,4}$/.test(value) ? Number(value) : null
}

// A BFCache pageshow reinstalls the observer on the same document. Keep its
// conservative account-switch state; only a genuinely new document resets it.
const documentScopes = new WeakMap<Document, { scope: string | null; suppressed: boolean }>()

/** Isolated preload only. Sends numbers and lifecycle flags, never message data. */
export function installGoogleVoiceUnread(document: Document, report: (value: { source: 'sms-navigation'; documentId: string; sequence: number; count: number | null; notificationsSuppressed?: boolean }) => Promise<unknown>): () => void {
  const view = document.defaultView
  if (!view || view !== view.top || view.location.origin !== 'https://voice.google.com') return () => {}
  const accountScope = () => /^\/u\/\d+(?=\/|$)/.exec(view.location.pathname)?.[0] ?? null
  const lifecycle = documentScopes.get(document) || { scope: accountScope(), suppressed: false }
  documentScopes.set(document, lifecycle)
  let documentId = view.crypto.randomUUID()
  let disposed = false, sequence = 0, timer: ReturnType<typeof setTimeout> | undefined, working = false
  let candidate: number | null | undefined, stableSince = 0, reported: number | null | undefined
  const schedule = () => { if (!disposed && !timer) timer = setTimeout(() => { timer = undefined; void sample() }, 350) }
  const sample = async () => {
    if (disposed || working) return
    const currentScope = accountScope()
    if (lifecycle.scope !== currentScope) {
      // The URL and account DOM can update separately. There is no reliable DOM
      // proof of which account owns a later count, so keep badges but suppress
      // notifications for the rest of this document, including BFCache restore.
      lifecycle.scope = currentScope; lifecycle.suppressed = true
      documentId = view.crypto.randomUUID(); sequence = 0
      candidate = undefined; reported = undefined; stableSince = 0
    }
    const count = lifecycle.scope === null ? null : readGoogleVoiceUnread(document)
    if (count !== candidate) { candidate = count; stableSince = Date.now(); schedule(); return }
    if (Date.now() - stableSince < 300) { schedule(); return }
    if (count === reported) return
    working = true
    const sentScope = lifecycle.scope
    try {
      const accepted = await report({ source: 'sms-navigation', documentId, sequence: ++sequence, count, ...(lifecycle.suppressed ? { notificationsSuppressed: true } : {}) })
      if (!disposed && sentScope === accountScope() && accepted === true) reported = count
    } catch { /* no page data or IPC failure details are logged */ }
    finally { working = false; if (!disposed && (sentScope !== accountScope() || readGoogleVoiceUnread(document) !== count)) schedule() }
  }
  const observer = new view.MutationObserver(schedule)
  observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'aria-hidden', 'aria-busy', 'style', 'hidden', 'inert'] })
  const periodic = setInterval(schedule, 5000)
  const dispose = () => { disposed = true; observer.disconnect(); clearInterval(periodic); clearTimeout(timer); view.removeEventListener('pagehide', pagehide); view.removeEventListener('popstate', schedule) }
  const pagehide = (event: PageTransitionEvent) => { dispose(); if (event.persisted) view.addEventListener('pageshow', () => installGoogleVoiceUnread(document, report), { once: true }) }
  view.addEventListener('pagehide', pagehide)
  view.addEventListener('popstate', schedule)
  schedule()
  return dispose
}
