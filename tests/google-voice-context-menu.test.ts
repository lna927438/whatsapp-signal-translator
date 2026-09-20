import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mainHarness } from './main-harness.ts'

const VOICE = 'https://voice.google.com/u/0/messages?itemId=t.synthetic'
function fixture() {
  const menus: any[] = [], calls: any[] = []
  let allowed = true
  class Contents extends EventEmitter {
    url = VOICE; destroyed = false
    mainFrame: any = { url: VOICE, detached: false }
    getURL() { return this.url }
    isDestroyed() { return this.destroyed }
    copy() { calls.push(['copy']) }
    cut() { calls.push(['cut']) }
    paste() { calls.push(['paste']) }
    pasteAndMatchStyle() { calls.push(['plain']) }
    selectAll() { calls.push(['all']) }
    undo() { calls.push(['undo']) }
    redo() { calls.push(['redo']) }
    copyImageAt(x: number, y: number) { calls.push(['image', x, y]) }
    downloadURL(src: string) { calls.push(['download', src]) }
  }
  const wc = new Contents()
  const h = mainHarness({ Menu: { buildFromTemplate(items: any[]) {
    const menu = { items, closed: 0, shown: 0, options: undefined as any, popup(options: any) { this.shown++; this.options = options }, closePopup() { this.closed++ } }
    menus.push(menu); return menu
  } } })
  const { installGoogleVoiceContextMenu } = h.load('src/main/platforms/googleVoice/contextMenu.ts')
  const dispose = installGoogleVoiceContextMenu(wc, () => allowed)
  const show = (patch: any = {}) => {
    wc.emit('context-menu', {}, { pageURL: wc.url, frameURL: wc.url, frame: wc.mainFrame, x: 25, y: 35, srcURL: '', mediaType: 'none', hasImageContents: false,
      isEditable: false, selectionText: '', editFlags: { canCopy: true, canCut: true, canPaste: true, canSelectAll: true, canUndo: true, canRedo: true }, ...patch })
    return menus.at(-1)
  }
  const invoke = (menu: any, label: string) => { const item = menu.items.find((row: any) => row.label === label); assert.ok(item, label); item.click() }
  return { wc, menus, calls, show, invoke, dispose, authorize(value: boolean) { allowed = value } }
}

test('Voice selected text and image actions target the captured contents without external navigation', () => {
  const f = fixture(), text = f.show({ selectionText: 'synthetic text' })
  f.invoke(text, '复制所选文字')
  assert.deepEqual(f.calls, [['copy']]); assert.equal(text.options.frame, f.wc.mainFrame)
  const src = 'https://lh3.googleusercontent.com/synthetic-image.png'
  const image = f.show({ mediaType: 'image', hasImageContents: true, srcURL: src, linkURL: 'https://example.invalid' })
  assert.equal(text.closed, 1); f.invoke(text, '复制所选文字'); assert.equal(f.calls.length, 1)
  f.invoke(image, '复制图片'); f.invoke(image, '图片另存为…')
  assert.deepEqual(f.calls.slice(1), [['image', 25, 35], ['download', src]])
  assert.equal(image.items.length, 2)
})

test('Voice editor native actions respect every disabled edit flag even if invoked programmatically', () => {
  const f = fixture(), labels = ['撤销', '重做', '剪切', '复制', '粘贴', '粘贴为纯文本', '全选']
  const disabled = f.show({ isEditable: true, editFlags: {} })
  for (const label of labels) { assert.equal(disabled.items.find((item: any) => item.label === label).enabled, false); f.invoke(disabled, label) }
  assert.deepEqual(f.calls, [])
  const enabled = f.show({ isEditable: true })
  for (const label of labels) f.invoke(enabled, label)
  assert.deepEqual(f.calls, [['undo'], ['redo'], ['cut'], ['copy'], ['paste'], ['plain'], ['all']])
})

test('authentication, lookalike, unauthorized, subframe and stale page menus never open', () => {
  const f = fixture()
  for (const url of ['https://accounts.google.com/ServiceLogin', 'https://accounts.google.co.th/', 'https://voice.google.com.evil.invalid/', 'https://voice.google.com@evil.invalid/', 'http://voice.google.com/', 'https://voice.google.com:8443/', 'https://user@voice.google.com/', 'https://voice%2egoogle.com/']) {
    f.wc.url = url; f.wc.mainFrame.url = url; f.show({ selectionText: 'synthetic' })
  }
  f.wc.url = VOICE; f.wc.mainFrame.url = VOICE
  f.authorize(false); f.show({ selectionText: 'synthetic' }); f.authorize(true)
  f.show({ frame: { url: VOICE, detached: false }, selectionText: 'synthetic' })
  f.show({ pageURL: VOICE + '-old', selectionText: 'synthetic' })
  f.show({ frameURL: 'https://accounts.google.com/', selectionText: 'synthetic' })
  assert.equal(f.menus.length, 0)
})

test('old menu clicks fail closed after account revocation, navigation, same-URL return or replacement frame', () => {
  for (const change of ['owner', 'different-url', 'navigation', 'same-document', 'frame', 'detached', 'crash']) {
    const f = fixture(), menu = f.show({ isEditable: true, mediaType: 'image', hasImageContents: true, srcURL: 'blob:https://voice.google.com/synthetic' })
    if (change === 'owner') f.authorize(false)
    if (change === 'different-url') f.wc.url += '-other'
    if (change === 'navigation') { f.wc.emit('did-start-navigation', { isMainFrame: true }, VOICE, false, true); f.wc.url = VOICE }
    if (change === 'same-document') f.wc.emit('did-navigate-in-page', {}, VOICE, true)
    if (change === 'frame') f.wc.mainFrame = { url: VOICE, detached: false }
    if (change === 'detached') f.wc.mainFrame.detached = true
    if (change === 'crash') f.wc.emit('render-process-gone', {}, {})
    for (const item of menu.items) item.click?.()
    assert.deepEqual(f.calls, [], change)
  }
})

test('only secure image resources and Voice blobs can be saved; unsafe schemes have no download action', () => {
  const f = fixture()
  for (const srcURL of ['javascript:alert(1)', 'file:///C:/secret', 'http://example.invalid/a.png', 'blob:https://accounts.google.com/id', 'data:text/html,a', 'data:image/svg+xml,<svg/>', 'https://user:secret@example.invalid/a.png']) {
    const menu = f.show({ mediaType: 'image', hasImageContents: true, srcURL })
    assert.equal(menu.items.some((item: any) => item.label === '图片另存为…'), false, srcURL)
  }
  for (const srcURL of ['blob:https://voice.google.com/synthetic', 'data:image/png;base64,AA==', 'https://lh3.googleusercontent.com/a.png']) {
    const menu = f.show({ mediaType: 'image', hasImageContents: true, srcURL }); f.invoke(menu, '图片另存为…')
  }
  assert.equal(f.calls.length, 3)
  const noPixels = f.show({ mediaType: 'canvas', hasImageContents: false }); f.invoke(noPixels, '复制图片')
  const badCoordinate = f.show({ mediaType: 'image', hasImageContents: true, x: NaN }); f.invoke(badCoordinate, '复制图片')
  assert.equal(f.calls.length, 3)
})

test('disposal and webContents destruction close menus, remove listeners and invalidate retained actions', () => {
  for (const destroy of [false, true]) {
    const f = fixture(), menu = f.show({ selectionText: 'synthetic' })
    if (destroy) { f.wc.destroyed = true; f.wc.emit('destroyed') } else f.dispose()
    f.dispose(); f.invoke(menu, '复制所选文字')
    assert.deepEqual(f.calls, []); assert.equal(menu.closed, 1)
    for (const event of ['context-menu', 'did-start-navigation', 'did-navigate-in-page', 'render-process-gone', 'destroyed']) assert.equal(f.wc.listenerCount(event), 0)
  }
})

test('unavailable content actions cannot escape as uncaught errors or target another account', () => {
  const f = fixture(), menu = f.show({ selectionText: 'synthetic' })
  f.wc.copy = () => { throw new Error('renderer closed') }
  assert.doesNotThrow(() => f.invoke(menu, '复制所选文字'))
  assert.deepEqual(f.calls, [])
})
