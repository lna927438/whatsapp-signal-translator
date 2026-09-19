import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { googleVoiceAppBundle } from './google-voice-ui-fixture.mjs'

const { chromium } = createRequire(import.meta.url)('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const folder = new URL('../verification/google-voice-ui-20260918/', import.meta.url)
await mkdir(folder, { recursive: true })
const bundle = await googleVoiceAppBundle()
const css = (await Promise.all(['style.css', 'hellodog.css', 'workspace.css', 'compactSidebar.css'].map(name => readFile(new URL('../src/renderer/src/' + name, import.meta.url), 'utf8')))).join('\n')
const assets = Object.fromEntries(await Promise.all(['google-voice.svg', 'whatsapp.svg', 'signal.svg', 'hellodog-icon.webp'].map(async name => [name, await readFile(new URL('../src/renderer/public/' + name, import.meta.url))])))
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const results = []
try {
  for (const [position, width, height] of [['top', 1280, 800], ['side', 960, 640]]) {
    const page = await browser.newPage({ viewport: { width, height } }), errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', route => { const name = route.request().url().split('/').at(-1); if (route.request().url() === 'https://fixture.example.invalid/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="app"></div></body></html>' }); return assets[name] ? route.fulfill({ contentType: name.endsWith('.svg') ? 'image/svg+xml' : 'image/webp', body: assets[name] }) : route.abort() })
    await page.goto('https://fixture.example.invalid/')
    await page.addStyleTag({ content: css })
    await page.evaluate(({ position }) => {
      window.__calls = []; window.__events = {}; window.__cloudBalance = 100000; window.__signalMounts = 0; window.__failVoiceFocus = false
      window.__voiceRecords = [{ id: 'v1', label: 'Voice 1', tabOrder: 0 }, { id: 'v2', label: 'Voice 2', tabOrder: 1 }]
      let nextId = 3
      const accounts = [{ id: 'wa1', platform: 'whatsapp', label: 'WhatsApp Test' }, { id: 'signal1', platform: 'signal', label: 'Signal Test', signalEngine: 'cli' }]
      const methods = {
        listAccounts: async () => structuredClone(accounts),
        getSettings: async () => ({ provider: 'deepseek', accountNavigationPosition: position, workspaceTheme: 'charcoal', quickReplies: ['Synthetic quick reply'] }),
        getLanguages: async () => [{ code: 'zh-CN', name: 'Chinese', zhName: '中文' }, { code: 'en-US', name: 'English', zhName: '英语' }],
        measureRoutes: async () => [], reliabilityStatus: async () => ({ online: true, version: 'synthetic', metrics: {}, accounts: [{ id: 'wa1', state: 'page-ready', pendingTranslations: 0 }], pendingSends: [] }),
        reliabilityHistory: async () => ['wa1', 'signal1', 'v1', 'v3'].map((accountId, index) => ({ requestId: 'synthetic-history-' + accountId, request: { accountId, targetLanguage: 'zh-CN', text: 'Synthetic text' }, sourceCharacters: 14, chargedCharacters: 14, createdAt: 1700000000000 + index, state: 'charged', translated: '样例译文' })),
        updateInfo: async () => ({ currentVersion: 'synthetic' }), contentRetention: async () => ({ days: 0 }),
        noticesSnapshot: async () => ({ notices: [], unread: 0 }), getAccountUnread: async () => ({}),
        listGoogleVoiceWindows: async () => structuredClone(window.__voiceRecords),
        addGoogleVoiceWindow: async () => { const record = { id: 'v' + nextId, label: 'Voice ' + nextId++, tabOrder: window.__voiceRecords.length }; window.__voiceRecords.push(record); return structuredClone(record) },
        updateGoogleVoiceWindow: async (id, patch) => { const record = window.__voiceRecords.find(row => row.id === id); Object.assign(record, patch); return structuredClone(record) },
        reorderGoogleVoiceWindows: async ids => { window.__voiceRecords = ids.map((id, tabOrder) => ({ ...window.__voiceRecords.find(row => row.id === id), tabOrder })); return structuredClone(window.__voiceRecords) },
        focusGoogleVoiceWindow: async id => { if (id && window.__failVoiceFocus) throw new Error('Synthetic browser unavailable') },
        refreshGoogleVoiceWindow: async () => {}, openGoogleVoiceExternal: async () => {},
        closeGoogleVoiceWindow: async id => { window.__voiceRecords = window.__voiceRecords.filter(row => row.id !== id); return true },
        setupGoogleVoiceTranslation: async () => ({ code: 'SYNTHETIC-PAIRING-CODE', expiresInSeconds: 300, extensionDirectory: 'D:/Synthetic/Extension', extensionId: 'synthetic', translationReady: false })
      }
      window.desktopAPI = new Proxy({}, { get(_target, key) {
        if (String(key).startsWith('on')) return listener => { window.__events[key] = listener; return () => { delete window.__events[key] } }
        return async (...args) => { window.__calls.push([key, ...args]); return methods[key] ? methods[key](...args) : undefined }
      } })
    }, { position })
    await page.addScriptTag({ content: bundle })
    assert.deepEqual(errors, [])
    await page.getByRole('button', { name: 'WhatsApp', exact: true }).click()
    await page.locator('.account-toolbar').waitFor()
    await page.getByRole('button', { name: 'Google Voice', exact: true }).click()
    await page.locator('.google-voice-navigation [data-account-id="v1"] [aria-current="true"]').waitFor()
    await page.waitForFunction(() => document.querySelector('.google-voice-content').getAttribute('aria-busy') === 'false')
    assert.equal(await page.locator('.account-toolbar').count(), 0)
    assert.equal(await page.locator('.workspace-status').count(), 0)
    assert.equal(await page.locator('.account-navigation.side').count(), 0, 'Voice always uses top window tabs')
    assert.match(await page.locator('.voice-protection-status').innerText(), /请以网页助手显示的保护状态为准/)
    const voiceQuota = page.locator('.voice-protection-status .quota-text')
    await page.waitForFunction(() => document.querySelector('.voice-protection-status .quota-text')?.textContent.includes('100,000'))
    assert.equal(await voiceQuota.evaluate(node => node.classList.contains('low')), false)
    await page.evaluate(() => { window.__cloudBalance = 49999; window.__events.onTranslatorStatus({ accountId: 'v1', state: 'success' }) })
    await page.waitForFunction(() => document.querySelector('.voice-protection-status .quota-text')?.textContent.includes('49,999'))
    assert.match(await voiceQuota.innerText(), /余额不足 50,000/)
    assert.equal(await voiceQuota.evaluate(node => node.classList.contains('low')), true)
    assert.equal(await voiceQuota.evaluate(node => getComputedStyle(node).color), 'rgb(255, 133, 141)', 'low balance uses the shared red warning')
    const barBounds = await page.locator('.voice-protection-status').boundingBox(), quotaBounds = await voiceQuota.boundingBox()
    assert.ok(quotaBounds.x >= barBounds.x && quotaBounds.x + quotaBounds.width <= barBounds.x + barBounds.width + 1)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.screenshot({ path: fileURLToPath(new URL('voice-low-balance-' + position + '.png', folder)) })
    await page.evaluate(() => { window.__cloudBalance = 50000; window.__events.onTranslatorStatus({ accountId: 'v1', state: 'success' }) })
    await page.waitForFunction(() => document.querySelector('.voice-protection-status .quota-text')?.textContent.includes('50,000'))
    assert.equal(await voiceQuota.evaluate(node => node.classList.contains('low')), false, '50,000 is not below the warning threshold')
    assert.equal(await page.locator('.google-voice-launcher img').evaluate(image => image.complete && image.naturalWidth > 0), true)
    await page.getByRole('button', { name: '新增 Google Voice 窗口', exact: true }).click()
    await page.locator('[data-account-id="v3"] [aria-current="true"]').waitFor()
    await page.getByRole('button', { name: '重命名窗口', exact: true }).click()
    const rename = page.getByRole('dialog', { name: '重命名 Google Voice 窗口' })
    await rename.getByRole('textbox').fill('Support')
    await rename.getByRole('button', { name: '保存名称' }).click()
    await rename.waitFor({ state: 'detached' })
    assert.equal(await page.locator('[data-account-id="v3"] .account-tab-name').innerText(), 'Support')
    const from = await page.locator('[data-account-id="v3"] .account-switch').boundingBox(), to = await page.locator('[data-account-id="v1"] .account-switch').boundingBox()
    await page.mouse.move(from.x + 30, from.y + 15); await page.mouse.down(); await page.mouse.move(to.x + 30, to.y + 15, { steps: 14 }); await page.mouse.up()
    await page.waitForFunction(() => window.__voiceRecords[0].id === 'v3')
    assert.deepEqual(await page.locator('.google-voice-navigation .account-tab').evaluateAll(nodes => nodes.map(node => node.dataset.accountId)), ['v3', 'v1', 'v2'])
    await page.locator('[data-account-id="v2"] .account-close').click()
    assert.equal(await page.locator('[data-account-id="v2"]').count(), 0)
    assert.equal(await page.locator('[data-account-id="v3"] [aria-current="true"]').count(), 1)
    await page.getByRole('button', { name: '连接翻译', exact: true }).click()
    const pairing = page.getByRole('dialog', { name: '连接 Google Voice 翻译' })
    await pairing.getByRole('textbox').waitFor()
    assert.equal(await pairing.getByRole('textbox').inputValue(), 'SYNTHETIC-PAIRING-CODE')
    assert.match(await pairing.innerText(), /配对成功本身不代表发送保护已生效/)
    await page.screenshot({ path: fileURLToPath(new URL('voice-pairing-' + position + '.png', folder)) })
    await page.keyboard.press('Escape')
    await pairing.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: '翻译记录与恢复', exact: true }).click()
    const recovery = page.getByRole('dialog', { name: '翻译记录与恢复', exact: true })
    const historyFilter = recovery.getByRole('combobox', { name: '翻译记录账号', exact: true })
    await recovery.locator('.receipt-row').waitFor()
    assert.equal(await historyFilter.inputValue(), 'v3', 'Voice opens history for the active Voice window')
    assert.match(await recovery.locator('.receipt-row').innerText(), /Support · zh-CN/)
    assert.deepEqual(await historyFilter.locator('option').evaluateAll(nodes => nodes.map(node => node.value)), ['', 'wa1', 'signal1', 'v3', 'v1'])
    await page.screenshot({ path: fileURLToPath(new URL('voice-history-' + position + '.png', folder)) })
    await historyFilter.selectOption('')
    assert.equal(await recovery.locator('.receipt-row').count(), 4)
    await recovery.getByRole('button', { name: '账号与运行', exact: true }).click()
    assert.equal(await recovery.locator('.runtime-accounts article').count(), 1)
    assert.match(await recovery.locator('.runtime-accounts').innerText(), /WhatsApp Test/)
    assert.doesNotMatch(await recovery.locator('.runtime-accounts').innerText(), /Voice|Support/)
    await recovery.getByRole('button', { name: '快捷操作', exact: true }).click()
    assert.equal(await recovery.getByRole('button', { name: 'Synthetic quick reply', exact: true }).isDisabled(), true, 'Voice must never insert a quick reply into a previous WhatsApp account')
    await recovery.locator('footer').getByRole('button', { name: '关闭', exact: true }).click()
    await recovery.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: '重新接入窗口', exact: true }).click()
    assert.equal(await page.evaluate(() => window.__calls.filter(call => call[0] === 'refreshGoogleVoiceWindow').at(-1)[1]), 'v3')
    await page.getByRole('button', { name: '在独立窗口中打开', exact: true }).click()
    await page.getByRole('button', { name: '打开窗口', exact: true }).waitFor()
    await page.getByRole('button', { name: '打开窗口', exact: true }).click()
    await page.getByRole('button', { name: 'Signal', exact: true }).click()
    const draft = page.getByRole('textbox', { name: 'Synthetic Signal draft' })
    await draft.fill('Keep this draft')
    await page.getByRole('button', { name: 'Google Voice', exact: true }).click()
    await page.locator('.google-voice-navigation').waitFor()
    assert.equal(await draft.isVisible(), false)
    await page.getByRole('button', { name: 'Signal', exact: true }).click()
    assert.equal(await draft.inputValue(), 'Keep this draft')
    assert.equal(await page.evaluate(() => window.__signalMounts), 1)
    await page.getByRole('button', { name: 'WhatsApp', exact: true }).click()
    assert.equal(await page.locator('[data-account-id="wa1"] [aria-current="true"]').count(), 1)
    await page.locator('.account-toolbar').waitFor()
    await page.getByRole('button', { name: '翻译记录与恢复', exact: true }).click()
    const waRecovery = page.getByRole('dialog', { name: '翻译记录与恢复', exact: true })
    await waRecovery.locator('.receipt-row').waitFor()
    assert.equal(await waRecovery.getByRole('combobox', { name: '翻译记录账号', exact: true }).inputValue(), 'wa1')
    await waRecovery.getByRole('button', { name: '快捷操作', exact: true }).click()
    await waRecovery.getByRole('button', { name: 'Synthetic quick reply', exact: true }).click()
    await waRecovery.waitFor({ state: 'detached' })
    assert.deepEqual(await page.evaluate(() => window.__calls.filter(call => call[0] === 'insertQuickReply')), [['insertQuickReply', 'wa1', 'Synthetic quick reply']])
    await page.evaluate(() => window.__failVoiceFocus = true)
    await page.getByRole('button', { name: 'Google Voice', exact: true }).click()
    await page.getByRole('button', { name: '重试', exact: true }).waitFor()
    assert.match(await page.locator('.voice-error').innerText(), /Synthetic browser unavailable/)
    await page.evaluate(() => window.__failVoiceFocus = false)
    await page.getByRole('button', { name: '重试', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.google-voice-content').getAttribute('aria-busy') === 'false')
    await page.locator('[data-account-id="v3"] .account-close').click()
    await page.locator('[data-account-id="v1"] .account-close').click()
    await page.getByRole('button', { name: '新增窗口', exact: true }).waitFor()
    assert.equal(await page.locator('.google-voice-navigation .account-tab').count(), 0)
    await page.screenshot({ path: fileURLToPath(new URL('voice-empty-' + position + '.png', folder)) })
    await page.getByRole('button', { name: '新增窗口', exact: true }).click()
    await page.locator('[data-account-id="v4"] [aria-current="true"]').waitFor()
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    assert.deepEqual(errors, [])
    const calls = await page.evaluate(() => window.__calls)
    assert.ok(calls.some(call => call[0] === 'setOverlayOpen' && call[1] === true))
    assert.ok(calls.some(call => call[0] === 'setOverlayOpen' && call[1] === false))
    results.push({ position, width, height, passed: true, nativeHostSimulated: true, signalDraftRetained: true, googleWindowCountAfterAdd: 1, accountMutations: calls.filter(call => ['addAccount', 'updateAccount', 'removeAccount', 'reorderAccounts'].includes(call[0])).length })
    await page.evaluate(() => window.__dispose()); await page.close()
  }
} finally { await browser.close() }
const report = { passed: true, at: new Date().toISOString(), scope: 'Real App.vue and Google Voice components in Edge with synthetic desktop IPC and Signal draft component. Native Chrome hosting, login, SMS, billing and extension pairing are not verified here.', syntheticOnly: true, realGoogleVoiceAccounts: false, realSmsSent: 0, realPairingCodesGenerated: 0, results }
await writeFile(new URL('embedded-browser-results.json', folder), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report))
