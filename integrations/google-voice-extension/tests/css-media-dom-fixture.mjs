import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const { chromium } = createRequire(import.meta.url)('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const folder = new URL('./artifacts/', import.meta.url); await mkdir(folder, { recursive: true })
const files = ['protocol.mjs', 'send-guard.mjs', 'voice-adapter.mjs', 'content-runtime.js']
const source = (await Promise.all(files.map(async file => (await readFile(new URL('../' + file, import.meta.url), 'utf8')).replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '')))).join('\n').replace('const adapter = new GoogleVoiceDomAdapter(document, location)', 'const adapter = new GoogleVoiceDomAdapter(document, location); window.fixtureRuntimeAdapter = adapter')
// Element/class/role structure was observed read-only on the official image
// caption draft, 2026-09-20. All content and image bytes below are synthetic.
const html = `<!doctype html><meta charset="utf-8"><style>body{font:14px Arial;padding:20px}gv-thread-details,gv-message-entry,gv-send-attachment-list{display:block}.container[role=grid]{display:flex;gap:12px}.item{position:relative}.item .content{width:160px;height:90px;background-size:contain;background-repeat:no-repeat}.close-icon-overlay{position:absolute;right:0;top:0;z-index:1;cursor:pointer}textarea{width:70%;height:70px}button{padding:9px;margin:5px}</style><h1>Owned official CSS image preview fixture</h1><gv-thread-details><gv-message-list></gv-message-list><gv-message-entry><div class="root"><gv-send-attachment-list><div class="container" role="grid"><div role="row"></div></div></gv-send-attachment-list><div class="container"><gv-message-actions><button aria-label="Add image">Add image</button><input type="file" multiple accept="image/jpeg,image/png,image/gif,image/bmp" style="display:none"></gv-message-actions><div class="message-input-container"><textarea class="message-input" aria-readonly="false" placeholder="Add a caption"></textarea></div><div class="button-container"><button class="send-button" aria-label="Send message with an attachment">Send</button></div></div></div></gv-message-entry></gv-thread-details>`
const browser = await chromium.launch({ channel: 'msedge', headless: true }), checks = [], errors = []
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 750 } }); page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }))
  await page.addInitScript({ content: `(() => {${source}\nwindow.fixtureRoots=[];const old=Element.prototype.attachShadow;Element.prototype.attachShadow=function(value){const root=old.call(this,value);window.fixtureRoots.push(root);return root};window.fixtureRequests=[];window.captionRequests=0;window.fixtureAdapter=new GoogleVoiceDomAdapter(document,location);window.fixtureRuntime=installGoogleVoiceRuntime({sendRequest:async message=>{window.fixtureRequests.push(message);const p=message.payload;let result;if(message.type==='voice.status')result={connected:true,targetLanguage:'en-US',localLanguage:'zh-CN',receiveAutoTranslate:false};else if(message.type==='voice.dispatch-status')result={state:'clear'};else if(message.type==='voice.outgoing-id')result={id:crypto.randomUUID()};else if(message.type==='voice.translate'){if(p.text.trim())window.captionRequests++;result={enabled:true,text:p.text.trim()?'Translated caption fixture':'',requestId:'send-fixture-'+p.id,...(p.media?{media:p.media}:{}),untranslated:!p.text.trim()}}else if(message.type==='voice.authorize')result={authorized:true,requestId:p.requestId,attempt:1};else result={resolved:true};return {ok:true,result}}});})()` })
  await page.goto('https://voice.google.com/u/0/messages?itemId=t.css-synthetic')
  await page.evaluate(() => {
    window.sent = []; window.renderedImages = []; window.nextPreviews = []; window.captionWrites = 0
    const entry = document.querySelector('gv-message-entry'), input = entry.querySelector('input[type=file]'), draft = entry.querySelector('textarea'), send = entry.querySelector('.send-button'), row = entry.querySelector('[role=row]')
    draft.addEventListener('input', event => { if (event.inputType === 'insertReplacementText') window.captionWrites++ })
    window.syntheticData = seed => { const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 18; const context = canvas.getContext('2d'); context.fillStyle = `rgb(${seed * 31 % 255},${seed * 47 % 255},120)`; context.fillRect(0, 0, 32, 18); return canvas.toDataURL('image/png') }
    window.renderPreviews = values => {
      window.renderedImages = [...values]; row.replaceChildren()
      values.forEach((data, index) => { const cell = document.createElement('div'); cell.className = 'item'; cell.setAttribute('role', 'gridcell'); const remove = document.createElement('span'); remove.className = 'close-icon-overlay'; remove.setAttribute('role', 'button'); remove.setAttribute('aria-label', 'Remove the ' + (index + 1) + 'st image'); remove.textContent = '×'; remove.onclick = () => window.renderPreviews(window.renderedImages.filter((_, removeIndex) => index !== removeIndex)); const content = document.createElement('div'); content.className = 'content'; content.style.backgroundImage = `url("${data}")`; cell.append(remove, content); row.append(cell) })
    }
    window.selectSynthetic = (seeds, { append = false, delayed = false, stalled = false } = {}) => {
      const transfer = new DataTransfer(), data = seeds.map(window.syntheticData)
      for (let index = 0; index < seeds.length; index++) { const bytes = Uint8Array.from(atob(data[index].split(',')[1]), char => char.charCodeAt(0)); const file = new File([bytes], 'synthetic-' + index + '.png', { type: 'image/png' }); if (stalled) file.arrayBuffer = () => new Promise(resolve => { (window.stalledReads ||= []).push(() => resolve(bytes.buffer)) }); transfer.items.add(file) }
      input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true })); window.nextPreviews = append ? [...window.renderedImages, ...data] : data
      if (!delayed) window.renderPreviews(window.nextPreviews)
    }
    send.addEventListener('click', () => { window.sent.push({ text: draft.value, count: window.renderedImages.length }); draft.value = ''; window.renderPreviews([]); draft.dispatchEvent(new Event('input', { bubbles: true })) })
  })
  const ready = async count => { await page.waitForFunction(count => [window.fixtureAdapter, window.fixtureRuntimeAdapter].every(adapter => { void adapter.refresh(); const current = adapter.snapshot(); return current && (current.media?.count || 0) === count }), count); await page.waitForFunction(() => document.querySelector('[data-hellodog-voice=toolbar] button')?.disabled === false) }
  const panelHas = async text => {
    try { await page.waitForFunction(text => window.fixtureRoots.some(root => root.host.isConnected && (root.textContent + [...root.querySelectorAll('textarea')].map(node => node.value).join('\n')).includes(text)), text, { timeout: 10000 }) }
    catch (error) { console.error(JSON.stringify(await page.evaluate(() => ({ panels: window.fixtureRoots.filter(root => root.host.isConnected).map(root => root.textContent + [...root.querySelectorAll('textarea')].map(node => node.value).join('\n')), operations: window.fixtureRequests.map(request => request.type), reason: window.fixtureAdapter.reason })))); throw error }
  }
  const panelClick = text => page.evaluate(text => { const root = [...window.fixtureRoots].reverse().find(root => root.host.isConnected); [...root.querySelectorAll('button')].find(button => button.textContent === text).click() }, text)
  const select = (seeds, options) => page.evaluate(({ seeds, options }) => window.selectSynthetic(seeds, options), { seeds, options })
  const send = () => page.locator('.send-button').click()
  await select([1]); await ready(1)
  assert.equal(await page.locator('gv-message-entry img').count(), 0)
  await send(); await panelHas('图片发送前预览')
  await page.screenshot({ path: fileURLToPath(new URL('css-media-image-preview.png', folder)) })
  assert.equal(await page.evaluate(() => window.captionRequests), 0); assert.deepEqual(await page.evaluate(() => window.sent), [])
  await panelClick('确认发送'); await panelHas('已提交')
  assert.deepEqual(await page.evaluate(() => window.sent), [{ text: '', count: 1 }]); await ready(0)
  assert.equal(await page.evaluate(() => window.captionWrites), 0)
  checks.push('official CSS grid with no img creates a pure-image preview and requires confirmation without a text translation request')
  assert.equal(await page.evaluate(() => document.querySelector('input[type=file]').files.length), 1)
  const cleared = await page.evaluate(() => { window.fixtureAdapter.inspect(); const record = window.fixtureAdapter.attachments.get(document.querySelector('gv-message-entry')); return { files: record.files.length, known: record.knownFiles.length, selected: record.selectedTokens.length, initial: record.initialTokens.length, media: !!record.cssMedia, signature: record.cssSignature } })
  assert.deepEqual(cleared, { files: 0, known: 0, selected: 0, initial: 0, media: false, signature: undefined })
  checks.push('last removal keeps the empty CSS root usable, never restores stale input.files and releases retained image data')
  await select([2]); await ready(1)
  const beforeReplacement = await page.evaluate(() => window.fixtureAdapter.snapshot().media.fingerprint)
  await select([3], { delayed: true })
  await page.waitForFunction(() => window.fixtureAdapter.attachments.get(document.querySelector('gv-message-entry'))?.work === false)
  assert.equal(await page.evaluate(async () => await window.fixtureAdapter.refresh()), false)
  await send(); await panelHas('正在等待所选图片的官方预览')
  assert.equal(await page.evaluate(() => window.sent.length), 1)
  await page.evaluate(() => { document.querySelector('gv-send-attachment-list .content').style.backgroundImage = `url("${window.nextPreviews[0]}")`; window.renderedImages = [...window.nextPreviews] })
  await ready(1)
  assert.notEqual(await page.evaluate(() => window.fixtureAdapter.snapshot().media.fingerprint), beforeReplacement)
  await page.waitForFunction(() => document.querySelector('[data-hellodog-voice=toolbar] button')?.disabled === false)
  checks.push('new File selection cannot authorize the still-visible previous image; a style-only preview update restores readiness')
  await page.locator('textarea').fill('图片中文说明')
  const prevented = await page.evaluate(() => { const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }); document.querySelector('textarea').dispatchEvent(event); return event.defaultPrevented })
  assert.equal(prevented, true); await panelHas('图片发送前预览')
  await page.screenshot({ path: fileURLToPath(new URL('css-media-caption-preview.png', folder)) })
  assert.equal(await page.locator('textarea').inputValue(), '图片中文说明'); assert.equal(await page.evaluate(() => window.sent.length), 1)
  await panelClick('确认发送'); await panelHas('已提交')
  assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { text: 'Translated caption fixture', count: 1 })
  assert.equal(await page.evaluate(() => window.captionWrites), 1)
  checks.push('caption Enter is intercepted before native send and only confirmed translated caption uses the actual attachment send button')
  await ready(0); await select([4]); await ready(1)
  await select([4], { append: true }); await ready(2)
  assert.equal(await page.evaluate(() => window.fixtureAdapter.snapshot().media.count), 2)
  await select([5], { append: true }); await ready(3)
  assert.equal(await page.evaluate(() => document.querySelector('input[type=file]').files.length), 1)
  await page.locator('.close-icon-overlay').first().click(); await ready(2)
  assert.deepEqual(await page.evaluate(() => window.fixtureAdapter.snapshot().media.types), ['image/png', 'image/png'])
  checks.push('reselecting identical bytes preserves image multiplicity; append uses new files only and partial removal rebuilds the exact current set')
  await send(); await panelHas('图片发送前预览')
  const beforeOldPreview = await page.evaluate(() => window.sent.length)
  await select([6]); await ready(1); await panelClick('确认发送'); await panelHas('草稿已变化')
  assert.equal(await page.evaluate(() => window.sent.length), beforeOldPreview)
  checks.push('changing selected image bytes invalidates an older prepared confirmation before authorization')
  await page.evaluate(() => { document.querySelector('gv-send-attachment-list .content').style.backgroundImage = `url("${window.syntheticData(7)}")` })
  await page.waitForFunction(() => window.fixtureAdapter.inspect() === null)
  await send(); await panelHas('图片预览与所选文件无法核对')
  checks.push('unselected or recompressed CSS image data fails explicitly instead of guessing or waiting forever')
  await page.locator('.close-icon-overlay').click(); await ready(0)
  await select([9]); await ready(1)
  const preserved = await page.evaluate(() => window.fixtureAdapter.snapshot().media.fingerprint)
  const rejected = await page.evaluate(() => {
    const transfer = new DataTransfer(); transfer.items.add(new File(['synthetic nonimage'], 'synthetic.txt', { type: 'text/plain' }))
    const input = document.querySelector('input[type=file]'); input.files = transfer.files
    const event = new Event('change', { bubbles: true, cancelable: true }); input.dispatchEvent(event)
    return { prevented: event.defaultPrevented, files: input.files.length }
  })
  await panelHas('此次选择已取消'); await ready(1)
  assert.deepEqual(rejected, { prevented: true, files: 0 }); assert.equal(await page.evaluate(() => window.fixtureAdapter.snapshot().media.fingerprint), preserved)
  checks.push('unsupported File selection is cancelled with an actionable notice while the earlier valid native image draft is preserved')
  await page.evaluate(() => {
    const input = document.querySelector('input[type=file]'), transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array([1, 2, 3, 4])], 'invalid.png', { type: 'image/png' })); input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true })); window.renderPreviews(['data:image/png;base64,AQIDBA=='])
  })
  await page.waitForFunction(() => [window.fixtureAdapter, window.fixtureRuntimeAdapter].every(adapter => !!adapter.attachments.get(document.querySelector('gv-message-entry'))?.error))
  await send(); await panelHas('图片无法核实')
  await page.locator('.close-icon-overlay').click(); await ready(0)
  await page.locator('textarea').fill('移除出错图片后继续文字'); await send(); await panelHas('HelloDog · 发送前预览')
  assert.equal(await page.evaluate(() => window.sent.length), beforeOldPreview)
  checks.push('undecodable image failure remains blocked until native removal, then the empty CSS editor resumes text translation without a send')
  await page.locator('textarea').fill('')
  await select([8], { stalled: true })
  await page.evaluate(() => { const now = Date.now.bind(Date); Date.now = () => now() + 10000 })
  await send(); await panelHas('图片读取未能完成')
  assert.equal(await page.evaluate(() => window.sent.length), beforeOldPreview)
  checks.push('a stalled File read reaches a bounded actionable failure even while its asynchronous work is pending')
  await page.screenshot({ path: fileURLToPath(new URL('css-media-stalled-error.png', folder)) })
  await page.locator('.close-icon-overlay').click(); await ready(0)
  await page.evaluate(async () => { window.stalledReads.forEach(resolve => resolve()); await Promise.resolve(); await Promise.resolve() })
  assert.equal(await page.evaluate(() => window.fixtureAdapter.snapshot().media), undefined)
  assert.equal(await page.evaluate(() => window.fixtureAdapter.attachments.get(document.querySelector('gv-message-entry')).knownFiles.length), 0)
  checks.push('removing a still-reading attachment releases the retained record; a late File read cannot restore its data or block the text composer')
  await select([10]); await ready(1)
  const noOpRejectsChange = await page.evaluate(async () => {
    const adapter = window.fixtureAdapter, original = adapter.snapshot()
    if (!adapter.replace(original, original.text)) throw new Error('unchanged draft was rejected')
    document.querySelector('gv-send-attachment-list .content').style.backgroundImage = `url("${window.syntheticData(11)}")`
    try { await adapter.settle(); return false } catch { return true }
  })
  assert.equal(noOpRejectsChange, true); assert.equal(await page.evaluate(() => window.sent.length), beforeOldPreview)
  checks.push('unchanged-caption no-op still rechecks the exact attachment before dispatch and rejects a changed preview without a native click')
  assert.equal(await page.evaluate(() => JSON.stringify(window.fixtureRequests).includes('data:image')), false)
  assert.deepEqual(errors, [])
  await page.screenshot({ path: fileURLToPath(new URL('css-media-dom-fixture.png', folder)) })
  const report = { at: new Date().toISOString(), passed: true, checks, scope: 'Owned synthetic Chromium fixture of the exact observed official CSS attachment editor. No real accounts, uploads, SMS, proxy calls or cloud billing.' }
  await writeFile(new URL('css-media-dom-results.json', folder), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report))
} finally { await browser.close() }
