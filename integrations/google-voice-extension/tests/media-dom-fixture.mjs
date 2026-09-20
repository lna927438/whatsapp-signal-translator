import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mainHarness } from '../../../tests/main-harness.ts'
const { chromium } = createRequire(import.meta.url)('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const output = new URL('./artifacts/', import.meta.url); await mkdir(output, { recursive: true })
const h = mainHarness(), { GoogleVoiceEmbeddedTranslation } = h.load('src/main/platforms/googleVoice/embeddedTranslation.ts'), { GoogleVoiceDispatchLedger } = h.load('src/main/platforms/googleVoice/dispatchLedger.ts'), { createGoogleVoiceTranslator } = h.load('src/main/platforms/googleVoice/translationBridge.ts')
let book = { records: {} }, journal = { records: [] }, quotaDenied = false, captionCalls = 0, historyCalls = 0, currentUrl = 'https://voice.google.com/u/0/messages?itemId=t.synthetic-media'
const requests = new Map(), calls = [], checks = [], errors = []
const store = (get, set) => ({ read: async () => structuredClone(get()), write: async value => set(structuredClone(value)) })
const translator = {
  history: async () => [], preserveOutgoingRequest: async value => { requests.set(value.requestId, value); return value }, prepareOutgoingRequest: async value => value, preserveIncomingRequest: async value => value,
  existingOutgoing: async id => { if (!requests.has(id)) throw new Error('missing receipt'); return requests.get(id) },
  translate: async () => { captionCalls++; return 'Image caption fixture' }, cached: async () => undefined,
  translateIncoming: async value => { historyCalls++; return '历史译文：' + value.text }
}
const handler = createGoogleVoiceTranslator(translator, { check: async () => { if (quotaDenied) throw new Error('可用字符已用完，无法发送翻译消息。请补充字符后重试，草稿已保留。') } }, async () => ({ localLanguage: 'zh-CN', targetLanguage: 'en-US', receiveAutoTranslate: true, sendAutoTranslate: true, historyMode: 'visible', translationsVisible: true, translationQuality: { tone: 'natural' } }), new GoogleVoiceDispatchLedger(store(() => journal, value => { journal = value })))
const bridge = new GoogleVoiceEmbeddedTranslation({ trustedPage: () => ({ owner: 'synthetic-owner', accountId: 'gv-11111111-1111-4111-a111-111111111111', url: currentUrl, authorized: () => true }), translate: handler, storage: store(() => book, value => { book = value }) })
const html = `<!doctype html><meta charset="utf-8"><style>body{font:14px Arial;padding:18px}gv-thread-details,gv-message-list,gv-message-item,gv-message-entry{display:block}.content{display:block;padding:10px;background:#edf2f7;border-radius:12px}.cdk-visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}textarea{width:80%;height:70px}gv-message-entry img{width:64px;height:64px;object-fit:contain}button{padding:8px;margin:4px}</style><h1>Owned image SMS fixture</h1><gv-thread-details><gv-message-list></gv-message-list><gv-message-entry><textarea class="message-input" aria-readonly="false"></textarea><gv-message-actions><button aria-label="添加图片">添加图片</button><input type="file" accept="image/png,image/jpeg,image/gif" multiple hidden></gv-message-actions><div class="image-previews"></div><button class="send-button" aria-label="发送消息" disabled>发送</button></gv-message-entry></gv-thread-details>`
const sourceFiles = ['protocol.mjs', 'send-guard.mjs', 'voice-adapter.mjs', 'content-runtime.js']
const source = (await Promise.all(sourceFiles.map(async file => (await readFile(new URL('../' + file, import.meta.url), 'utf8')).replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '')))).join('\n')
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } }); page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }))
  await page.exposeFunction('fixtureBridge', async (message, url) => { currentUrl = url; calls.push(structuredClone(message)); return bridge.request({}, message) })
  await page.addInitScript({ content: `(() => {${source}\nwindow.fixtureRoots=[];const old=Element.prototype.attachShadow;Element.prototype.attachShadow=function(value){const root=old.call(this,value);window.fixtureRoots.push(root);return root};window.fixtureAdapter=new GoogleVoiceDomAdapter(document,location);window.fixtureRuntime=installGoogleVoiceRuntime({sendRequest:message=>window.fixtureBridge(message,location.href)});})()` })
  async function load() {
    await page.goto(currentUrl)
    await page.evaluate(() => {
      window.sent = []; window.imageOpened = false
      const entry = document.querySelector('gv-message-entry'), draft = entry.querySelector('textarea'), send = entry.querySelector('.send-button'), input = entry.querySelector('input[type=file]'), previews = entry.querySelector('.image-previews')
      window.updateSend = () => { send.disabled = !draft.value.trim() && !previews.children.length }
      draft.addEventListener('input', window.updateSend)
      entry.querySelector('[aria-label="添加图片"]').addEventListener('click', () => { window.imageOpened = true })
      input.addEventListener('change', () => { previews.replaceChildren(); for (const file of input.files) { const image = document.createElement('img'); image.src = URL.createObjectURL(file); previews.append(image) }; window.updateSend() })
      send.addEventListener('click', () => { window.sent.push({ text: draft.value, count: previews.children.length }); draft.value = ''; previews.replaceChildren(); draft.dispatchEvent(new Event('input', { bubbles: true })); window.updateSend() })
    })
    await page.waitForSelector('[data-hellodog-voice="toolbar"]')
  }
  async function selectImage(seed = 0) {
    await page.evaluate(seed => {
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC3sAAAAASUVORK5CYII='), char => char.charCodeAt(0))
      // Synthetic PNG with a trailing marker changes bytes without a private file.
      const file = new File([bytes, new Uint8Array([seed])], 'synthetic.png', { type: 'image/png' }), transfer = new DataTransfer(); transfer.items.add(file)
      const input = document.querySelector('input[type=file]'); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }))
    }, seed)
    await page.waitForFunction(() => { void window.fixtureAdapter.refresh(); return !!window.fixtureAdapter.snapshot()?.media })
  }
  async function panelHas(text) { await page.waitForFunction(value => window.fixtureRoots.some(root => root.host.isConnected && (root.textContent + [...root.querySelectorAll('textarea')].map(node => node.value).join('\n')).includes(value)), text) }
  async function clickPanel(text) { await page.evaluate(text => { const root = [...window.fixtureRoots].reverse().find(root => root.host.isConnected); const button = [...root.querySelectorAll('button')].find(node => node.textContent === text); if (!button || button.disabled) throw new Error('missing panel action'); button.click() }, text) }
  async function prepare(text = '') { await page.locator('textarea').fill(text); await page.locator('.send-button').click() }
  await load()
  await page.getByRole('button', { name: '添加图片', exact: true }).click()
  assert.equal(await page.evaluate(() => window.imageOpened), true)
  await selectImage()
  await prepare(); await panelHas('图片发送前预览')
  await page.screenshot({ path: fileURLToPath(new URL('media-image-preview.png', output)) })
  assert.deepEqual(await page.evaluate(() => window.sent), []); assert.equal(captionCalls, 0)
  await clickPanel('确认发送'); await panelHas('已提交')
  assert.deepEqual(await page.evaluate(() => window.sent), [{ text: '', count: 1 }]); assert.equal(captionCalls, 0)
  assert.equal(journal.records.length, 1); assert.equal(journal.records[0].state, 'uncertain')
  checks.push('localized native image control opens, image-only preview authorizes once with durable receipt and zero translation calls')
  await load(); await selectImage(); await prepare(); await panelHas('发送结果待核对')
  assert.deepEqual(await page.evaluate(() => window.sent), []); assert.equal(captionCalls, 0)
  await clickPanel('已核对：确认未发送'); await panelHas('已确认未发送')
  assert.equal(journal.records[0].state, 'not-sent')
  await prepare(); await panelHas('图片发送前预览'); await clickPanel('确认发送'); await panelHas('已提交')
  assert.equal(journal.records[0].attempts, 2); assert.equal(captionCalls, 0)
  checks.push('full reload and reselection of identical bytes detects uncertain send; explicit not-sent keeps media namespace and authorizes one retry')
  await selectImage(1); await prepare('这是图片说明'); await panelHas('图片发送前预览')
  assert.equal(captionCalls, 1)
  const before = await page.evaluate(() => window.sent.length)
  await selectImage(2); await clickPanel('确认发送'); await panelHas('草稿已变化')
  assert.equal(await page.evaluate(() => window.sent.length), before)
  checks.push('image replacement after translated caption preview blocks authorization and dispatch')
  quotaDenied = true; await prepare('需要余额的图片说明'); await panelHas('可用字符不足')
  assert.equal(captionCalls, 1); assert.equal(await page.locator('textarea').inputValue(), '需要余额的图片说明'); quotaDenied = false
  checks.push('caption quota failure preserves Chinese and images without translation call or raw-language fallback')
  await prepare('翻译图片说明'); await panelHas('图片发送前预览'); await clickPanel('确认发送'); await panelHas('已提交')
  assert.equal(await page.evaluate(() => window.sent.at(-1).text), 'Image caption fixture')
  assert.equal(await page.evaluate(() => window.sent.at(-1).count), 1)
  checks.push('Chinese caption is translated then submitted with its bound native image after explicit confirmation')
  await page.evaluate(() => {
    document.querySelector('textarea').disabled = true
    document.querySelector('gv-message-list').innerHTML = '<gv-message-item><div class="full-container incoming"><div class="message-row"><gv-annotation class="content">A readable historical message</gv-annotation></div><div class="status">2:36 PM</div><span class="cdk-visually-hidden">Message from Synthetic, A readable historical message, Sunday, September 20 2026, 2:36 PM.</span></div></gv-message-item>'
  })
  await page.waitForFunction(() => document.querySelector('[data-hellodog-voice="translation"]')?.textContent.startsWith('历史译文'))
  assert.equal(historyCalls, 1)
  checks.push('historical messages translate while the send composer is disabled')
  await page.evaluate(() => { document.querySelector('textarea').disabled = false })
  const blockedMedia = await page.evaluate(() => {
    const result = []
    for (const type of ['video/mp4', 'audio/mpeg', 'application/pdf']) {
      const transfer = new DataTransfer(); transfer.items.add(new File(['synthetic'], 'fixture', { type }))
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }); document.querySelector('textarea').dispatchEvent(event); result.push(event.defaultPrevented)
    }
    return result
  })
  assert.deepEqual(blockedMedia, [true, true, true]); await panelHas('视频和音频附件不在此发送范围内')
  checks.push('video audio and arbitrary files are rejected clearly instead of silently bypassing send protection')
  await page.evaluate(() => history.pushState({}, '', '/u/0/messages?itemId=new'))
  await page.locator('textarea').fill('新收件人不得猜测'); await page.locator('.send-button').click(); await panelHas('完整选定 1–7 位收件人')
  assert.equal(await page.locator('textarea').inputValue(), '新收件人不得猜测')
  checks.push('invalid new-recipient route remains explicitly blocked before translation or dispatch')
  assert.ok(calls.filter(call => ['voice.outgoing-id', 'voice.authorize', 'voice.dispatch-status', 'voice.dispatch-resolve'].includes(call.type)).every(call => call.payload.media?.fingerprint))

  // Selected recipient markup was observed from the official page on 2026-09-20.
  // Values below are exclusively reserved synthetic numbers; no real recipient
  // or message is read, modified or transmitted by this fixture.
  await page.evaluate(() => {
    history.pushState({}, '', '/u/0/messages?itemId=draft')
    const picker = document.createElement('gv-message-party-picker')
    picker.innerHTML = '<mat-chip-grid style="display:block"></mat-chip-grid><input class="mat-mdc-chip-input" aria-label="Add recipients">'
    document.querySelector('gv-thread-details').prepend(picker)
    window.setRecipients = numbers => {
      const grid = picker.querySelector('mat-chip-grid'); grid.replaceChildren()
      for (const number of numbers) {
        const chip = document.createElement('mat-chip-row'); chip.className = 'chip-row'; chip.style.display = 'inline-flex'
        const name = document.createElement('div'); name.className = 'chip-name'; name.textContent = 'Synthetic recipient'
        const accessible = document.createElement('div'); accessible.className = 'cdk-visually-hidden'; accessible.textContent = number
        const remove = document.createElement('button'); remove.setAttribute('gv-test-id', 'chip-item-remove'); remove.textContent = 'Remove'; remove.onclick = () => chip.remove()
        chip.append(name, accessible, remove); grid.append(chip)
      }
    }
  })
  await prepare('完整选定后才发送'); await panelHas('完整选定 1–7 位收件人')
  const beforeRecipients = captionCalls
  await page.evaluate(() => window.setRecipients(['\u200e(202) 555-0101\u200e', '(202) 555-0102']))
  await page.waitForFunction(() => { void window.fixtureAdapter.refresh(); return window.fixtureAdapter.snapshot()?.context?.recipientCount === 2 })
  const groupSnapshot = await page.evaluate(() => window.fixtureAdapter.snapshot().context)
  assert.equal(JSON.stringify(groupSnapshot).includes('202'), false); assert.match(groupSnapshot.recipientKey, /^[a-f0-9]{64}$/)
  await page.evaluate(() => window.setRecipients(['+1 (202) 555-0102', '+1 (202) 555-0101']))
  await page.waitForFunction(() => { void window.fixtureAdapter.refresh(); return window.fixtureAdapter.supported })
  assert.deepEqual(await page.evaluate(() => window.fixtureAdapter.snapshot().context), groupSnapshot)
  checks.push('observed selected chips produce a stable privacy-safe recipient hash across display formatting and group order')
  for (const mode of ['partial', 'duplicate', 'too-many', 'name-only']) {
    await page.evaluate(mode => {
      window.setRecipients(mode === 'duplicate' ? ['(202) 555-0101', '(202) 555-0101'] : mode === 'too-many' ? Array.from({ length: 8 }, (_, index) => '(202) 555-010' + index) : mode === 'name-only' ? ['Synthetic contact with no confirmed number'] : ['(202) 555-0101'])
      document.querySelector('.mat-mdc-chip-input').value = mode === 'partial' ? '20255' : ''
    }, mode)
    await prepare('不完整目标保持草稿'); await panelHas('完整选定 1–7 位收件人')
    assert.equal(captionCalls, beforeRecipients)
  }
  checks.push('partial duplicate more-than-seven and name-only recipients block before provider use')
  await page.evaluate(() => window.setRecipients(['(202) 555-0101', '(202) 555-0102']))
  await prepare('群组中文草稿'); await panelHas('发送前预览')
  const authorizationsBeforeChange = calls.filter(call => call.type === 'voice.authorize').length
  await page.evaluate(() => window.setRecipients(['(202) 555-0101', '(202) 555-0103']))
  await clickPanel('确认发送'); await panelHas('页面版本尚未支持')
  assert.equal(calls.filter(call => call.type === 'voice.authorize').length, authorizationsBeforeChange)
  assert.equal(await page.locator('textarea').inputValue(), '群组中文草稿')
  checks.push('changing a selected recipient after preview blocks authorization and preserves the Chinese draft')
  await prepare('群组首次发送跨路由样例'); await panelHas('发送前预览')
  await page.screenshot({ path: fileURLToPath(new URL('media-group-preview.png', output)) })
  const groupRequest = calls.filter(call => call.type === 'voice.translate' && call.payload.direction === 'outgoing').at(-1)
  assert.equal(groupRequest.payload.context.recipientCount, 2)
  await page.evaluate(() => document.querySelector('.send-button').addEventListener('click', () => { document.querySelector('gv-message-party-picker').remove(); history.pushState({}, '', '/u/0/messages?itemId=t.synthetic-first-group') }, { once: true }))
  await clickPanel('确认发送'); await page.waitForURL('**/messages?itemId=t.synthetic-first-group')
  currentUrl = page.url(); await load()
  const beforeRouteRecovery = captionCalls
  await prepare('群组首次发送跨路由样例'); await panelHas('发送结果待核对')
  assert.equal(captionCalls, beforeRouteRecovery); assert.deepEqual(await page.evaluate(() => window.sent), [])
  await clickPanel('已核对：确认未发送'); await panelHas('请返回“发送新短信”，重新选择原来的收件人并恢复原草稿')
  assert.equal(journal.records.at(-1).state, 'uncertain'); assert.equal(captionCalls, beforeRouteRecovery)
  await page.screenshot({ path: fileURLToPath(new URL('media-dispatch-scope.png', output)) })
  checks.push('cross-route not-sent recovery displays the main dispatch-scope guidance, keeps the uncertain reservation and adds no charge')
  await clickPanel('已核对：确认已发送'); await panelHas('已确认发送')
  assert.equal(journal.records.at(-1).state, 'sent')
  checks.push('first group send changing draft to official thread route survives full reload and requires explicit outcome without another charge')
  assert.ok(calls.filter(call => call.payload?.conversationId === groupRequest.payload.conversationId && call.type !== 'voice.status').every(call => call.payload.context?.recipientKey))

  const oversizedGif = await page.evaluate(() => {
    const input = document.querySelector('input[type=file]'), transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'oversized.gif', { type: 'image/gif' })); input.files = transfer.files
    const event = new Event('change', { bubbles: true, cancelable: true }); input.dispatchEvent(event)
    return { prevented: event.defaultPrevented, previews: document.querySelectorAll('.image-previews img').length }
  })
  assert.deepEqual(oversizedGif, { prevented: true, previews: 0 })
  checks.push('GIF larger than two MiB is blocked before the native file-change upload handler')
  assert.deepEqual(errors, [])
  await page.screenshot({ path: fileURLToPath(new URL('media-dom-fixture.png', output)) })
  const report = { at: new Date().toISOString(), passed: true, checks, captionTranslationCalls: captionCalls, historyTranslationCalls: historyCalls, scope: 'Owned localized legacy img-preview compatibility fixture through production main embedded translator and dispatch ledger, synthetic File bytes and mock translation/wallet. The observed official CSS attachment editor has a separate css-media-dom fixture. No real Google SMS, uploads, account or cloud charges.' }
  await writeFile(new URL('media-dom-results.json', output), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report))
} finally { await browser.close() }
