/** Covers official Web A composers before its async translator is installed. */
export function installTelegramBootstrapGuard(ready: () => boolean, blocked: () => void) {
  const element = (value: EventTarget | null) => value instanceof Element ? value : value instanceof Node ? value.parentElement : null
  const stop = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); event.stopPropagation(); blocked() }
  const key = (event: KeyboardEvent) => {
    if (ready() || event.key !== 'Enter' || !element(event.target)?.closest('#editable-message-text,#editable-message-text-modal,.Composer [contenteditable="true"]')) return
    if (event.isComposing || event.keyCode === 229) { event.stopImmediatePropagation(); event.stopPropagation(); return }
    if (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) return
    stop(event)
  }
  const click = (event: MouseEvent) => {
    if (ready()) return
    const button = element(event.target)?.closest('button,[role="button"]')
    if (!button || button.closest('[data-rt-ui]')) return
    if (button.matches('.main-button.send,.main-button.edit,.main-button.schedule,.main-button.sendOneTime')
      || button.closest('.Modal,.modal-dialog') && (button.querySelector('.icon-new-send,.icon-send') || button.matches('[class*="send"]'))) stop(event)
  }
  window.addEventListener('keydown', key, true)
  window.addEventListener('click', click, true)
  return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('click', click, true) }
}
