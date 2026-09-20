import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = require('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const root = new URL('../', import.meta.url), output = new URL('./artifacts/', import.meta.url)
await mkdir(output, { recursive: true })
const samples = [
  { id: 'short-in', direction: 'incoming', text: 'Stop', translation: '停止' },
  { id: 'short-out', direction: 'outgoing', text: 'Thank you!', translation: '谢谢你！' },
  { id: 'long-in', direction: 'incoming', text: 'Please keep this link open. Visit https://example.invalid/' + 'x'.repeat(160), translation: '这是一条较长的中文译文。原文中的链接仍然可以正常选中和打开，译文不会被再次当作原文处理。'.repeat(3), link: true },
  { id: 'long-out', direction: 'outgoing', text: 'This is a synthetic longer outgoing message. It keeps the original wording and wraps naturally in the same message bubble. '.repeat(2).trim(), translation: '这是一条较长的发出消息译文。英文在上方，中文在下方。\n换行后仍然保留在同一个气泡中，不覆盖时间戳。'.repeat(2) }
]
const status = { connected: true, localLanguage: 'zh-CN', targetLanguage: 'en-US', receiveAutoTranslate: true, sendAutoTranslate: true, historyMode: 'visible', translationsVisible: true }
const calls = [], checks = [], errors = []
const message = (sample, index) => `<gv-message-item id="${sample.id}"><div class="full-container ${sample.direction}"><div class="message-row ${sample.direction === 'outgoing' ? 'outgoing' : ''}"><gv-annotation class="content"><span class="original">${sample.link ? 'Please keep this link open. Visit <a href="https://example.invalid/">https://example.invalid/' + 'x'.repeat(160) + '</a>' : sample.text}</span></gv-annotation></div><div class="status">2:0${index} PM</div><span class="cdk-visually-hidden">Message from Synthetic sender, ${sample.text}, Sunday, September 20 2026, 2:0${index} PM.</span></div></gv-message-item>`
const html = `<!doctype html><meta charset="utf-8"><title>Synthetic bilingual message bubble fixture</title><style>
  *{box-sizing:border-box}body{margin:0;background:#fff;color:#202124;font:14px/1.45 Arial;padding:20px 20px 130px}h1{font-size:18px}gv-thread-details,gv-message-list,gv-message-item,gv-message-entry{display:block}gv-message-item{margin:12px 0}.message-row{display:flex;justify-content:flex-start}.message-row.outgoing{justify-content:flex-end}gv-annotation.content{display:block;width:fit-content;min-width:0;max-width:76%;padding:10px 16px;border-radius:20px;background:#f1f3f4;overflow-wrap:anywhere}.outgoing gv-annotation.content{background:#d3e3fd;color:#174ea6}.status{font-size:11px;color:#5f6368;margin:3px 16px}.outgoing .status{text-align:right}.cdk-visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}gv-message-entry{position:fixed;bottom:0;left:0;width:100%;padding:12px;background:#fff;border-top:1px solid #ddd}textarea{width:70%;height:48px}button{padding:8px}a{color:inherit}body.dark{background:#131314;color:#e3e3e3}.dark gv-annotation.content{background:#282a2c}.dark .outgoing gv-annotation.content{background:#0842a0;color:#d3e3fd}.dark gv-message-entry{background:#131314}.dark .status{color:#c4c7c5}
  </style><h1>Local fixture · bilingual message bubbles</h1><gv-thread-details><gv-message-list>${samples.map(message).join('')}</gv-message-list><gv-message-entry><textarea class="message-input" aria-readonly="false"></textarea><gv-message-actions><button aria-label="Add image">Add image</button></gv-message-actions><button class="send-button" aria-label="Send message" disabled>Send</button></gv-message-entry></gv-thread-details>`
// Bundle the actual modules with test-only access to the adapter/runtime. All
// routes are fulfilled locally; no Google session, SMS, provider or charge.
const modules = await Promise.all(['protocol.mjs', 'send-guard.mjs', 'voice-adapter.mjs', 'content-runtime.js'].map(async file => (await readFile(new URL(file, root), 'utf8')).replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '')))
const content = `(() => {${modules.join('\n')}\nwindow.fixtureAdapter = new GoogleVoiceDomAdapter(document, location); window.fixtureRuntime = installGoogleVoiceRuntime({sendRequest: message => window.fixtureBridge(message)});})()`
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1500 } })
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }))
  await page.exposeFunction('fixtureBridge', message => {
    if (message.type === 'voice.status') return { ok: true, result: { ...status } }
    if (message.type !== 'voice.translate' || message.payload.direction !== 'incoming') throw new Error('Unexpected operation in read-only bubble fixture')
    calls.push(structuredClone(message.payload))
    const sample = samples.find(sample => sample.text === message.payload.text)
    assert.ok(sample, 'translation input must equal untouched original text')
    return { ok: true, result: { enabled: true, text: sample.translation, requestId: message.payload.id } }
  })
  await page.addInitScript({ content })
  await page.goto('https://voice.google.com/u/0/messages?itemId=t.synthetic-bubbles')
  await page.waitForFunction(() => document.querySelectorAll('[data-hellodog-voice="translation"]').length === 4 && [...document.querySelectorAll('[data-hellodog-voice="translation"]')].every(node => !node.querySelector('button')))
  assert.equal(calls.length, samples.length)
  const identities = await page.evaluate(async () => { await window.fixtureAdapter.refresh(); return (await window.fixtureAdapter.messages()).map(item => ({ id: item.id, text: item.text, valid: window.fixtureAdapter.validMessage(item) })) })
  assert.deepEqual(identities.map(item => item.text), samples.map(item => item.text))
  assert.equal(identities.every(item => item.valid), true)
  checks.push('original text and durable message identities exclude nested translations and controls')

  async function assertBubbleLayout(label) {
    const geometry = await page.evaluate(() => [...document.querySelectorAll('gv-message-item')].map(item => {
      const bubble = item.querySelector('gv-annotation.content'), translation = item.querySelector('[data-hellodog-voice="translation"]'), original = item.querySelector('.original'), stamp = item.querySelector('.status')
      const bounds = node => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right } }
      const source = document.createRange(); source.selectNodeContents(original)
      return { id: item.id, count: item.querySelectorAll('[data-hellodog-voice="translation"]').length, parent: translation.parentElement === bubble, order: !!(original.compareDocumentPosition(translation) & Node.DOCUMENT_POSITION_FOLLOWING), bubble: bounds(bubble), translation: bounds(translation), source: bounds(source), stamp: bounds(stamp), color: getComputedStyle(translation).color, nativeColor: getComputedStyle(bubble).color, sourceColor: getComputedStyle(original).color, lang: translation.lang, overflow: bubble.scrollWidth > bubble.clientWidth + 1 }
    }))
    for (const entry of geometry) {
      assert.equal(entry.count, 1, label + ' ' + entry.id)
      assert.equal(entry.parent && entry.order, true, label + ' same bubble, source first')
      assert.ok(entry.translation.top >= entry.source.bottom - 1, label + ' translation below original')
      assert.ok(entry.translation.left >= entry.bubble.left && entry.translation.right <= entry.bubble.right + 1, label + ' translation inside bubble width')
      assert.ok(entry.translation.bottom <= entry.bubble.bottom + 1 && entry.stamp.top >= entry.bubble.bottom - 1, label + ' translation above external timestamp')
      assert.equal(entry.color, entry.nativeColor, label + ' readable inherited foreground')
      assert.equal(entry.sourceColor, entry.nativeColor, label + ' original formatting retained')
      assert.equal(entry.lang, 'zh-CN')
      assert.equal(entry.overflow, false, label + ' no horizontal clipping')
    }
  }
  await assertBubbleLayout('light wide')
  checks.push('short and long incoming/outgoing translations stay below original inside the native bubble and above timestamp')
  await page.screenshot({ path: fileURLToPath(new URL('bubble-light-wide.png', output)), fullPage: true })
  await page.setViewportSize({ width: 420, height: 1400 })
  await assertBubbleLayout('light narrow')
  await page.evaluate(() => document.body.classList.add('dark'))
  await assertBubbleLayout('dark narrow')
  await page.screenshot({ path: fileURLToPath(new URL('bubble-dark-narrow.png', output)), fullPage: true })
  checks.push('420px narrow layout, long unbroken URL, multiline translation and dark theme preserve bounds and foreground contrast')
  assert.equal(await page.locator('#long-in .original a').getAttribute('href'), 'https://example.invalid/')
  assert.equal(await page.locator('#long-in .original a').count(), 1)
  checks.push('original annotation markup and links are retained without wrapping or replacing source')

  // Official re-render replaces the annotation while retaining its message
  // item. The existing result must reattach to the new content without charge.
  await page.evaluate(() => {
    const content = document.querySelector('#long-out gv-annotation.content'), replacement = content.cloneNode(true)
    replacement.querySelector('[data-hellodog-voice]').remove(); content.replaceWith(replacement)
  })
  await page.waitForFunction(() => document.querySelector('#long-out gv-annotation.content [data-hellodog-voice="translation"]')?.textContent.startsWith('这是一条'))
  assert.equal(calls.length, samples.length)
  const redrawIdentities = await page.evaluate(async () => (await window.fixtureAdapter.messages()).map(item => ({ id: item.id, text: item.text, valid: window.fixtureAdapter.validMessage(item) })))
  assert.deepEqual(redrawIdentities, identities)
  await assertBubbleLayout('official redraw')
  checks.push('official content replacement remounts one translation with unchanged identity and no repeat request')

  await page.evaluate(() => {
    const translated = document.querySelector('#short-in [data-hellodog-voice="translation"]'), child = document.createElement('span')
    child.textContent = 'nested translated control text'; translated.append(child)
  })
  assert.deepEqual(await page.evaluate(async () => (await window.fixtureAdapter.messages()).map(item => item.text)), samples.map(item => item.text))
  checks.push('nested translation descendants cannot contaminate message extraction')
  await page.evaluate(() => { window.fixtureRuntime.dispose(); window.fixtureAdapter.dispose() })
  assert.equal(await page.locator('[data-hellodog-voice]').count(), 0)
  assert.deepEqual(await page.locator('.original').allTextContents(), samples.map(item => item.text))
  checks.push('runtime cleanup removes only injected UI and restores intact official source bubbles')
  assert.deepEqual(errors, [])
  const result = { at: new Date().toISOString(), passed: true, checks, requestCount: calls.length, scope: 'Owned synthetic Chromium DOM/layout fixture using production runtime and adapter; no real account, SMS, cloud requests or billing' }
  await writeFile(new URL('bubble-results.json', output), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
} finally { await browser.close() }
