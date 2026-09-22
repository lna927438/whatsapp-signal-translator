import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const { chromium } = require('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const { whatsappSidebarScript } = require('../src/main/platforms/whatsapp/inject/sidebar.ts')
const { whatsappPresenceScript } = require('../src/main/platforms/whatsapp/inject/presence.ts')
const folder = new URL('../verification/whatsapp-surface-20260922/', import.meta.url)
await mkdir(folder, { recursive: true })
const html = (display, home) => `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;color:#e9edef;font:14px system-ui;background:#161717}#shell{height:100vh;display:flex}nav{width:52px;flex:none;background:#202c33}#layout{position:relative;display:${display};grid-template-columns:340px minmax(0,1fr);flex:1;min-width:0}#column{width:340px;flex:0 0 340px;border-right:1px solid #374045}#side{width:100%;height:100%;padding:20px 14px}#column.hidden{display:none}#side h2{margin:0 0 25px}#side input{width:100%;padding:12px;background:#2a2f32;color:#eee;border:0;border-radius:20px}#side p{padding:15px 10px;border-radius:10px;background:#2a2f32}#main,#welcome{position:relative;flex:1;min-width:0;display:flex;flex-direction:column}header{height:64px;flex:none;padding:12px 18px;background:#202c33}.history{flex:1;overflow:auto;padding:20px}footer{padding:12px;background:#202c33}footer textarea{width:100%;height:44px;padding:10px;background:#2a3942;color:#fff;border:0;border-radius:9px}.native-presence{font-size:12px}
</style><div id="shell"><nav aria-label="官方导航"></nav><div id="layout"><div id="column"><div id="side"><h2>WhatsApp</h2><input placeholder="搜索或开始新聊天"><p>示例联系人</p></div></div><div id="${home ? 'welcome' : 'main'}"><header><div><span title="Alex" dir="auto">Alex</span><div class="native-presence"><span>online</span></div></div></header><div class="history">本地结构验证，不连接聊天服务</div><footer><textarea>未发送的示例草稿</textarea></footer></div></div></div>`
const browser = await chromium.launch({ channel: 'msedge', headless: true }), results = []
try {
  for (const [display, home] of [['flex', false], ['grid', false], ['flex', true], ['grid', true]]) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 760 } }), errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html(display, home) }))
    await page.goto('https://whatsapp-fixture.invalid/')
    await page.evaluate(whatsappSidebarScript + whatsappPresenceScript)
    const divider = page.getByRole('separator', { name: '调整 WhatsApp 聊天列表宽度' })
    await divider.waitFor()
    const width = async () => Math.round((await page.locator('#column').boundingBox()).width)
    const aligned = async () => {
      const side = await page.locator('#side').boundingBox(), column = await page.locator('#column').boundingBox(), content = await page.locator(home ? '#welcome' : '#main').boundingBox()
      assert.ok(Math.abs(side.x + side.width - (column.x + column.width)) <= 1)
      assert.ok(Math.abs(column.x + column.width - content.x) <= 1)
      assert.equal(await divider.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)')
      assert.equal(await page.locator('textarea').inputValue(), '未发送的示例草稿')
    }
    const start = async () => {
      const box = await divider.boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + 180); await page.mouse.down()
    }
    // Native fixed max-width must not leave an unused strip after a real drag.
    await page.locator(home ? '#welcome' : '#main').evaluate(node => node.style.maxWidth = '780px')
    await start(); await page.mouse.move(52 + 460, 180, { steps: 10 }); await page.mouse.up()
    assert.ok(Math.abs(await width() - 460) <= 1); await aligned()
    // Capture failure is recoverable through document listeners.
    await divider.evaluate(node => { node.setPointerCapture = () => { throw new Error('synthetic capture unavailable') } })
    await start(); await page.mouse.move(52 + 500, 180, { steps: 6 }); await page.mouse.up()
    assert.ok(Math.abs(await width() - 500) <= 1); await aligned()
    // Cancel restores the starting width. Subsequent pointer movement is inert.
    await start(); await page.mouse.move(52 + 560, 180, { steps: 6 })
    await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })))
    await page.mouse.up(); assert.ok(Math.abs(await width() - 500) <= 1)
    await page.mouse.move(52 + 620, 180); assert.ok(Math.abs(await width() - 500) <= 1)
    // Window blur commits the last valid width and removes active drag state.
    await start(); await page.mouse.move(52 + 530, 180, { steps: 4 }); await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await page.mouse.move(52 + 590, 180); await page.mouse.up(); assert.ok(Math.abs(await width() - 530) <= 1); await aligned()
    // React replaces the column while dragging: exactly one usable divider.
    await start(); await page.evaluate(() => { const column = document.querySelector('#column'); column.replaceWith(column.cloneNode(true)) }); await page.mouse.up()
    await page.waitForTimeout(120); assert.equal(await divider.count(), 1)
    await divider.focus(); await page.keyboard.press('Home'); assert.equal(await width(), 340)
    await page.keyboard.press('Tab'); await aligned()
    await page.locator('#column').evaluate(node => node.classList.add('hidden')); await page.waitForTimeout(100); assert.equal(await divider.count(), 0)
    await page.locator('#column').evaluate(node => node.classList.remove('hidden')); await divider.waitFor({ timeout: 3000 }).catch(async error => {
      console.error(JSON.stringify({ display, home, errors, nodes: await page.locator('#layout,#column,#side,#main,#welcome,[role=separator]').evaluateAll(nodes => nodes.map(node => ({ id: node.id, rect: node.getBoundingClientRect().toJSON(), css: node.getAttribute('style'), display: getComputedStyle(node).display }))) })); throw error
    }); assert.equal(await divider.count(), 1)
    await page.setViewportSize({ width: 760, height: 620 }); await page.waitForTimeout(120); await aligned()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    if (!home) {
      const status = page.locator('[data-hd-presence-kind]'); assert.equal(await status.count(), 1); assert.equal(await status.innerText(), 'online')
      await page.locator('.native-presence').evaluate(node => node.innerHTML = '<div>正在输入…</div>'); await page.waitForTimeout(120)
      assert.equal(await status.count(), 1); assert.equal(await status.innerText(), '正在输入…')
      assert.equal(Math.round((await page.locator('header').boundingBox()).height), 64)
    }
    await page.screenshot({ path: fileURLToPath(new URL(display + (home ? '-home' : '-conversation') + '.png', folder)) })
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
    assert.equal(await divider.count(), 0); assert.equal(await page.locator('[data-hd-presence-kind]').count(), 0)
    assert.equal(await page.locator('textarea').inputValue(), '未发送的示例草稿'); assert.deepEqual(errors, [])
    results.push({ display, home, realBrowserLayout: true, pointerCaptureFallback: true, pointerCancel: true, blur: true, dynamicReplacement: true, noExtraDivider: true, draftPreserved: true })
    await page.close()
  }
} finally { await browser.close() }
const report = { passed: true, fixtureOnly: true, liveAccountsUsed: false, providerCalls: 0, messagesSent: 0, results }
await writeFile(new URL('results.json', folder), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report))
