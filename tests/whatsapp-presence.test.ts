import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'
const { whatsappPresenceScript, parseWhatsAppPresence } = createRequire(import.meta.url)('../src/main/platforms/whatsapp/inject/presence.ts')
const settle = () => new Promise(resolve => setTimeout(resolve, 120))
function fixture(status = '<span class="native-presence">online</span>') {
  const dom = new JSDOM('<div id="side"><span title="online">online</span></div><div id="main"><header style="height:64px"><div class="identity"><span title="Alex" dir="auto">Alex</span>' + status + '</div><button>Call</button></header><div class="history">online</div></div>', { url: 'https://web.whatsapp.com', runScripts: 'outside-only', pretendToBeVisual: true })
  const w = dom.window as any, doc = w.document
  // Intentionally no note or translation bridge: native status is independent.
  w.eval(whatsappPresenceScript)
  return { dom, w, doc, native: () => doc.querySelector('.native-presence'), enhanced: () => doc.querySelectorAll('[data-hd-presence-kind]') }
}

test('only native online, typing, recording and last-seen text is recognized', () => {
  for (const [text, kind] of [['online', 'online'], ['正在输入…', 'typing'], ['recording audio...', 'recording'], ['last seen today at 01:36', 'last-seen']]) assert.equal(parseWhatsAppPresence(text)?.kind, kind)
  for (const text of ['Online sales group', 'Alex, Ben, me', '']) assert.equal(parseWhatsAppPresence(text), undefined)
})

test('native status remains visible with no note API, no injected rows, and unchanged header height', async () => {
  const h = fixture()
  try {
    await settle()
    assert.equal(h.native().textContent, 'online'); assert.equal(h.native().dataset.hdPresenceKind, 'online')
    assert.notEqual(h.w.getComputedStyle(h.native()).display, 'none')
    assert.equal(h.doc.querySelector('header').style.height, '64px'); assert.equal(h.doc.querySelector('header').style.minHeight, '')
    assert.equal(h.doc.querySelector('[data-rt-ui],dialog,textarea'), null)
    assert.equal(h.enhanced().length, 1); assert.equal(h.doc.querySelector('#side span').style.color, '')
    h.native().textContent = 'typing...'; await settle(); assert.equal(h.native().dataset.hdPresenceKind, 'typing')
    h.native().textContent = 'last seen today at 01:36'; await settle(); assert.equal(h.native().dataset.hdPresenceKind, 'last-seen')
    assert.equal(h.native().textContent, 'last seen today at 01:36')
  } finally { h.dom.window.close() }
})

test('nested div status is styled once and modern header replacement never leaves stale status', async () => {
  const h = fixture('<div class="native-presence"><div>在线</div></div>')
  try {
    assert.equal(h.enhanced().length, 1); assert.equal(h.enhanced()[0], h.native().firstElementChild)
    const old = h.enhanced()[0]
    h.doc.querySelector('header').innerHTML = '<div><span title="Ben" dir="auto">Ben</span><div class="native-presence">正在录音…</div></div>'
    await settle(); assert.equal(h.enhanced().length, 1); assert.equal(h.native().dataset.hdPresenceKind, 'recording')
    assert.equal(old.style.color, ''); assert.equal(old.hasAttribute('data-hd-presence-kind'), false)
    h.native().remove(); await settle(); assert.equal(h.enhanced().length, 0)
    assert.equal(h.doc.querySelector('header').textContent, 'Ben')
  } finally { h.dom.window.close() }
})

test('hidden or private native status is not inferred from names and native changes survive cleanup', async () => {
  const h = fixture()
  try {
    h.native().style.display = 'none'; await settle(); assert.equal(h.enhanced().length, 0)
    h.native().style.display = ''; await settle(); assert.equal(h.enhanced().length, 1)
    h.doc.querySelector('header').setAttribute('hidden', ''); await settle(); assert.equal(h.enhanced().length, 0)
    h.doc.querySelector('header').removeAttribute('hidden'); await settle(); assert.equal(h.enhanced().length, 1)
    h.native().textContent = ''; h.doc.querySelector('span[title="Alex"]').textContent = 'online'; await settle()
    assert.equal(h.enhanced().length, 0)
    h.native().textContent = 'online'; await settle(); h.native().style.color = 'red'
    h.w.dispatchEvent(new h.w.Event('pagehide')); assert.equal(h.native().style.color, 'red'); assert.equal(h.enhanced().length, 0)
    assert.equal(h.w.__HD_PRESENCE__, undefined)
  } finally { h.dom.window.close() }
})
