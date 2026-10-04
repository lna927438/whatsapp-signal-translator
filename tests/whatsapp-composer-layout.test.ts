import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'
const { readWhatsAppComposerText } = createRequire(import.meta.url)('../src/main/platforms/whatsapp/inject/composerText.ts')

test('composer extraction keeps authored breaks and image emoji independently of visual wrapping and paragraph margins', () => {
  const cases = [
    ['<p><span>Hello</span> friend<img alt="🙂" aria-hidden="true"></p>', 'Hello friend🙂'],
    ['<p>First</p><p>Second</p>', 'First\nSecond'],
    ['<p>First</p><p><br></p><p>Second</p>', 'First\n\nSecond'],
    ['<p>First</p><p></p><p></p><p>Second</p>', 'First\n\n\nSecond'],
    ['First<div>Second</div>Third', 'First\nSecond\nThird'],
    ['<p>Hello</p><img alt="😊"><p>World</p>', 'Hello\n😊\nWorld'],
    ['First<br>Second<br><br>Fourth', 'First\nSecond\n\nFourth'],
    ['<p>Hello  friend&nbsp;🙂<span data-rt-ui="annotation">Never send</span></p>', 'Hello  friend 🙂'],
    ['<p>Hi <span><img alt="中"></span></p>', 'Hi 中']
  ]
  for (const [html, expected] of cases) {
    const dom = new JSDOM(`<div contenteditable>${html}</div>`)
    try {
      const composer = dom.window.document.querySelector('div')!
      Object.defineProperty(composer, 'innerText', { value: 'layout must not control the draft\n\n' })
      assert.equal(readWhatsAppComposerText(composer), expected, html)
    } finally { dom.window.close() }
  }
})
