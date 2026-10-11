import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { mainHarness } from './main-harness.ts'

const { chromium } = createRequire(import.meta.url)('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const modules = mainHarness()
const { telegramInjectionScript } = modules.load('src/main/platforms/telegram/inject/script.ts')
const output = new URL('../verification/telegram-20261012/', import.meta.url)
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const checks = []
try {
  for (const [width, height] of [[1200, 800], [480, 720], [320, 400]]) {
    const page = await browser.newPage({ viewport: { width, height } }), errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#15232e;color:#eef6fc;font:15px/1.5 system-ui}header{padding:16px;background:#223440}button{font:inherit}#MiddleColumn{transform:translateX(0);height:120px;overflow:hidden;padding:20px}.Message{background:#324d61;padding:12px;border-radius:12px;margin:10px 0}</style><div id="LeftColumn"></div><header>Telegram · 本地布局验收 <button id="read-history">查看聊天记录</button></header><div id="MiddleColumn"><div class="MessageList"><div class="Message" data-message-id="10"><div class="message-content"><div class="text-content">Existing chat remains readable and interactive.</div></div></div></div><div class="Composer"><div id="editable-message-text" contenteditable="true"></div><button class="main-button send">Send</button></div></div>' }))
    await page.goto('https://web.telegram.org/a/#12345')
    await page.evaluate(() => {
      const task = { id: 'synthetic-send', state: 'uncertain', conversationId: 'telegram:12345:0', targetKey: 'peer:telegram:12345:0:editable-message-text', request: { text: '测试长消息，保留官网聊天区域。'.repeat(180) }, translated: 'UnbrokenLongMessage'.repeat(180) }
      window.realtimeTranslator = {
        getRuntimeSettings: async () => ({ receiveAutoTranslate: false, historyMode: 'manual' }),
        pendingSends: async () => [structuredClone(task)],
        reportConversation() {}, reportStatus() {}, reportConnection() {}, reportUnread() {},
      }
      document.querySelector('#read-history').onclick = () => { window.historyClicked = true }
    })
    await page.evaluate(telegramInjectionScript)
    await page.locator('[data-rt-ui="send-reconcile"]').waitFor()
    const layout = await page.evaluate(() => {
      const panel = document.querySelector('[data-rt-ui="send-reconcile"]'), content = panel.querySelector('.hd-tg-reconcile-content'), actions = panel.querySelector('.hd-tg-reconcile-actions')
      const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }
      return { panel: rect(panel), actions: rect(actions), buttons: [...actions.querySelectorAll('button')].map(rect), contentHeight: content.clientHeight, contentScrollHeight: content.scrollHeight, contentWidth: content.clientWidth, contentScrollWidth: content.scrollWidth, pageWidth: document.documentElement.scrollWidth, bodyPortal: panel.parentElement === document.body }
    })
    assert.equal(layout.bodyPortal, true)
    assert.ok(layout.panel.left >= 0 && layout.panel.right <= width && layout.panel.top >= 0 && layout.panel.bottom <= height)
    assert.ok(layout.panel.height <= height * .45 + 1 && layout.panel.top >= height * .5)
    assert.ok(layout.contentScrollHeight > layout.contentHeight && layout.contentHeight > 0)
    assert.ok(layout.contentScrollWidth <= layout.contentWidth + 1 && layout.pageWidth <= width)
    for (const rect of layout.buttons) assert.ok(rect.left >= layout.panel.left && rect.right <= layout.panel.right && rect.top >= layout.panel.top && rect.bottom <= layout.panel.bottom)
    await page.getByRole('button', { name: '查看聊天记录' }).click()
    assert.equal(await page.evaluate(() => window.historyClicked), true)
    assert.deepEqual(errors, [])
    const filename = `telegram-reconcile-${width}x${height}.png`
    await page.screenshot({ path: new URL(filename, output).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true })
    checks.push({ width, height, ...layout, screenshot: filename })
    await page.close()
  }
  const report = { passed: true, at: new Date().toISOString(), scope: 'Isolated Edge, synthetic Telegram DOM and send task. Every network request fulfilled locally; no account, messages, provider or charges.', checks }
  await writeFile(new URL('telegram-reconcile-layout.json', output), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser.close()
  assert.match(relative(resolve(tmpdir()), resolve(modules.directory)), /^hellodog-test-[A-Za-z0-9]+$/)
  await rm(modules.directory, { recursive: true, force: true })
}
