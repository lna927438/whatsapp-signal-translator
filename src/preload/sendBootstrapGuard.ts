/** Installed before the page scripts. Never let an uninitialized translator fall through to native send. */
export function installSendBootstrapGuard(ready: () => boolean, blocked: () => void) {
  const stop = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); event.stopPropagation(); blocked() }
  const element = (target: EventTarget | null) => target instanceof Element ? target : target instanceof Node ? target.parentElement : null
  const composer = (target: EventTarget | null) => element(target)?.closest('[contenteditable="true"],[contenteditable="plaintext-only"]')
  const key = (event: KeyboardEvent) => {
    const editor = composer(event.target)
    if (event.key !== 'Enter' || !editor || !editor.closest('#main,footer,[role="dialog"]')) return
    if (event.isComposing || event.keyCode === 229) { event.stopImmediatePropagation(); event.stopPropagation(); return }
    if (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) return
    if (!ready()) stop(event)
  }
  const click = (event: MouseEvent) => {
    if (ready()) return
    const button = element(event.target)?.closest('button,[role="button"]')
    if (!button || button.closest('[data-rt-ui]') || !button.closest('#main,footer,[role="dialog"]')) return
    if (/send|发送/i.test([button.getAttribute('aria-label'), button.getAttribute('data-testid'), button.getAttribute('data-icon')].join(' '))
      || button.querySelector('[data-icon*="send"],[data-testid*="send"]')) stop(event)
  }
  window.addEventListener('keydown', key, true)
  window.addEventListener('click', click, true)
  return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('click', click, true) }
}
