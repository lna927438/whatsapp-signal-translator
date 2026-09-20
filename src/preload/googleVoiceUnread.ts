/** The visible Messages navigation, hidden zero badge, responsive hidden clone
 * and positive active badge were observed read-only on 2026-09-20.
 * Positive counts require one exact rendered badge;
 * abbreviated/unknown markup is unavailable, never an inferred inbox count. */
export function readGoogleVoiceUnread(document: Document): number | null {
  const links = [...document.querySelectorAll('mat-nav-list a[role="tab"][gv-test-id="sidenav-messages"]')].filter(link => link.getClientRects().length > 0)
  if (links.length !== 1 || links[0].closest('[aria-busy="true"]')) return null
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

/** Isolated preload only. Sends numbers, not names, text, IDs or phone numbers. */
export function installGoogleVoiceUnread(document: Document, report: (value: { source: 'sms-navigation'; documentId: string; sequence: number; count: number | null }) => Promise<unknown>): () => void {
  const view = document.defaultView
  if (!view || view !== view.top || view.location.origin !== 'https://voice.google.com') return () => {}
  const documentId = view.crypto.randomUUID()
  let disposed = false, sequence = 0, timer: ReturnType<typeof setTimeout> | undefined, working = false
  let candidate: number | null | undefined, stableSince = 0, reported: number | null | undefined
  const schedule = () => { if (!disposed && !timer) timer = setTimeout(() => { timer = undefined; void sample() }, 350) }
  const sample = async () => {
    if (disposed || working) return
    const count = readGoogleVoiceUnread(document)
    if (count !== candidate) { candidate = count; stableSince = Date.now(); schedule(); return }
    if (Date.now() - stableSince < 300) { schedule(); return }
    if (count === reported) return
    working = true
    try {
      const accepted = await report({ source: 'sms-navigation', documentId, sequence: ++sequence, count })
      if (!disposed && accepted === true) reported = count
    } catch { /* no page data or IPC failure details are logged */ }
    finally { working = false; if (!disposed && readGoogleVoiceUnread(document) !== count) schedule() }
  }
  const observer = new view.MutationObserver(schedule)
  observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'aria-hidden', 'aria-busy', 'style'] })
  const periodic = setInterval(schedule, 5000)
  const dispose = () => { disposed = true; observer.disconnect(); clearInterval(periodic); clearTimeout(timer); view.removeEventListener('pagehide', pagehide) }
  const pagehide = (event: PageTransitionEvent) => { dispose(); if (event.persisted) view.addEventListener('pageshow', () => installGoogleVoiceUnread(document, report), { once: true }) }
  view.addEventListener('pagehide', pagehide)
  schedule()
  return dispose
}
