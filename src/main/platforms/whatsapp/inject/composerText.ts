/** Read authored content, not layout-dependent innerText. Chromium inserts
 * visual paragraph gaps into innerText and omits image-backed emoji from it.
 * Keep this function self-contained: the page injection serializes it. */
export function readWhatsAppComposerText(composer: Element | null | undefined, nested = false): string {
  if (!composer) return ''
  let text = '', previousBlock = false
  for (const node of Array.from(composer.childNodes)) {
    if (node.nodeType === 3) {
      if (previousBlock && text && !text.endsWith('\n') && node.nodeValue) text += '\n'
      text += node.nodeValue || ''; previousBlock = false; continue
    }
    if (node.nodeType !== 1) continue
    const element = node as Element
    if (element.matches('[data-rt-ui],script,style,[hidden]')) continue
    const tag = element.tagName.toLowerCase()
    if (tag === 'br') { text += '\n'; previousBlock = false; continue }
    if (tag === 'img') {
      const alt = element.getAttribute('alt') || ''
      if (alt) {
        if (previousBlock && text && !text.endsWith('\n')) text += '\n'
        text += alt; previousBlock = false
      }
      continue
    }
    const block = /^(p|div|li)$/.test(tag), value = readWhatsAppComposerText(element, true)
    // A block boundary is one author-entered line, regardless of CSS margins.
    // An empty block contributes another boundary, preserving blank lines.
    if ((block || previousBlock) && text && !text.endsWith('\n')) text += '\n'
    text += value
    if (block && !value) text += '\n'
    previousBlock = block
  }
  return nested ? text : text.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim()
}
