import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
const require = createRequire(import.meta.url)
const { chromium } = require('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const { whatsappInjectionScript } = require('../src/main/platforms/whatsapp/inject/script.ts')
const output = new URL('../verification/reliability-20261004/', import.meta.url)
await mkdir(output, { recursive: true })
const html = '<!doctype html><meta charset="utf-8"><style>[contenteditable]{white-space:pre-wrap;width:200px}p{margin:1em 0}</style><div id="main"><header><span title="Synthetic" dir="auto">Synthetic</span></header><div class="message-in" data-id="false_fixture@c.us_old"><span class="selectable-text">Hi</span></div><footer><div contenteditable="true" role="textbox"></div><button aria-label="Send">Send</button></footer></div>'
const browser = await chromium.launch({ channel: 'msedge', headless: true }), checks = []
try {
  for (const scenario of [
    { name: 'Single paragraph and image emoji survive narrow visual wrapping', html: '<p>Hello <img alt="🙂" aria-hidden="true"> this is one long authored line and it should stay one line.</p>', source: 'Hello 🙂 this is one long authored line and it should stay one line.', translated: 'Hello 🙂 this is one long authored line and it should stay one line.', click: true },
    { name: 'CSS paragraph margins do not become extra blank lines', html: '<p>第一行</p><p>第二行</p>', source: '第一行\n第二行', translated: 'First line\nSecond line' },
    { name: 'Explicit blank paragraph remains a blank paragraph', html: '<p>第一行</p><p><br></p><p>第三行</p>', source: '第一行\n\n第三行', translated: 'First line\n\nThird line' },
    { name: 'Final dispatch refuses a renderer-added blank paragraph', html: '<p>你好朋友</p>', source: '你好朋友', translated: 'Hello friend', tamper: 'Hello\n\nfriend' },
    { name: 'Final dispatch refuses extra horizontal spaces', html: '<p>你好朋友</p>', source: '你好朋友', translated: 'Hello friend', tamper: 'Hello  friend' },
    { name: 'Final dispatch refuses original Chinese substituted after translation', html: '<p>你好朋友</p>', source: '你好朋友', translated: 'Hello friend', tamper: '你好朋友' },
    { name: 'Provider failure leaves original draft and never enters native send', html: '<p>保留原文</p>', source: '保留原文', translated: 'Keep original', offline: true }
  ]) {
    const page = await browser.newPage(), errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }))
    await page.goto('https://web.whatsapp.com/__hellodog_synthetic_fixture__')
    await page.evaluate(scenario => {
      const composer = document.querySelector('[contenteditable]'), button = document.querySelector('button')
      composer.innerHTML = scenario.html
      window.fixture = { prepared: [], clicks: 0, completed: false, status: [], task: null, result: null }
      const f = window.fixture
      window.realtimeTranslator = {
        reportConversation() {}, reportStatus(value) { f.status.push(value) },
        getRuntimeSettings: async () => ({ receiveAutoTranslate: false }),
        cachedIncoming: async () => undefined, pendingSend: async () => f.task,
        prepareSend: async value => { f.prepared.push(value); return f.task = { ...value, id: 'send-fixture', state: 'draft', request: { text: value.text }, translated: scenario.translated, targetLanguage: 'en-US' } },
        translateSend: async () => { await new Promise(resolve => setTimeout(resolve, 80)); if (scenario.offline) throw new Error('Synthetic offline'); return f.task },
        submitSend: async () => {
          const args = { ...f.task, original: f.task.request.text }
          if (!window.__RT_SEND_SELECT__(args)) throw new Error('Snapshot refused')
          composer.textContent = scenario.tamper || scenario.translated
          f.result = await window.__RT_SEND_COMMIT__(args)
          await window.__RT_SEND_RELEASE__(args.id, f.result.dispatched === false)
          f.completed = true
          if (f.result.dispatched === false) throw new Error(f.result.message)
          return f.task
        }
      }
      button.addEventListener('click', () => {
        f.clicks++
        const bubble = document.createElement('div'); bubble.className = 'message-out'; bubble.dataset.id = 'true_fixture@c.us_sent'
        const text = document.createElement('span'); text.className = 'selectable-text'; text.textContent = composer.textContent
        f.sent = text.textContent; bubble.appendChild(text); document.querySelector('#main').insertBefore(bubble, document.querySelector('footer')); composer.textContent = ''
      })
    }, scenario)
    await page.evaluate(whatsappInjectionScript)
    if (scenario.click) await page.getByRole('button', { name: 'Send', exact: true }).dblclick()
    else { await page.getByRole('textbox').focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Enter') }
    await page.waitForFunction(() => window.fixture.completed || window.fixture.status.some(value => value.state === 'error'))
    const result = await page.evaluate(() => ({ ...window.fixture, draft: document.querySelector('[contenteditable]').textContent }))
    assert.equal(result.prepared.length, 1, scenario.name)
    assert.equal(result.prepared[0].text, scenario.source, scenario.name)
    assert.equal(result.clicks, scenario.tamper || scenario.offline ? 0 : 1, scenario.name)
    if (!scenario.tamper && !scenario.offline) assert.equal(result.sent, scenario.translated, scenario.name)
    if (scenario.offline) assert.equal(result.draft, scenario.source)
    assert.deepEqual(errors, [])
    checks.push(scenario.name); await page.close()
  }
  const report = { at: new Date().toISOString(), passed: true, checks, scope: 'Isolated Microsoft Edge with every network request fulfilled locally, synthetic contacts, provider and receipts only. No real WhatsApp account, message, external API or charge.' }
  await writeFile(new URL('whatsapp-send-layout-browser.json', output), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally { await browser.close() }
