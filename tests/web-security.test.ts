import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mainHarness } from './main-harness.ts'

test('media permission grants are scoped to device, account and current document', async () => {
  let check: Function, request: Function
  const session = Object.assign(new EventEmitter(), {
    setPermissionCheckHandler: (fn: Function) => { check = fn },
    setPermissionRequestHandler: (fn: Function) => { request = fn },
    setDisplayMediaRequestHandler: () => {}
  })
  let answer: (value: { response: number }) => void
  const h = mainHarness({
    app: { isPackaged: true },
    BrowserWindow: { fromWebContents: () => null },
    dialog: { showMessageBox: () => new Promise(resolve => { answer = resolve }) }
  })
  const { installWebSecurity } = h.load('src/main/webSecurity.ts')
  const contents = (id: number) => Object.assign(new EventEmitter(), {
    id, session, isDestroyed: () => false, getURL: () => 'https://web.whatsapp.com/',
    setWindowOpenHandler: () => {}
  })
  const first = contents(1), second = contents(2)
  installWebSecurity(first, 'whatsapp'); installWebSecurity(second, 'whatsapp')
  const details = { requestingUrl: first.getURL(), isMainFrame: true, mediaTypes: ['audio'] }
  const grant = (wc: unknown) => new Promise<boolean>(resolve => request(wc, 'media', resolve, details))
  const allowed = grant(first); answer!({ response: 1 }); assert.equal(await allowed, true)
  const media = { isMainFrame: true, mediaType: 'audio' }
  assert.equal(check!(first, 'media', first.getURL(), media), true)
  assert.equal(check!(first, 'media', first.getURL(), { ...media, mediaType: 'video' }), false)
  assert.equal(check!(first, 'media', first.getURL(), { ...media, isMainFrame: false }), false)
  assert.equal(check!(second, 'media', second.getURL(), media), false)
  first.emit('did-start-navigation', {}, first.getURL(), false, true)
  assert.equal(check!(first, 'media', first.getURL(), media), false)
  const pending = grant(second)
  second.emit('did-start-navigation', {}, second.getURL(), false, true)
  answer!({ response: 1 }); assert.equal(await pending, false)
  first.emit('destroyed')
  const reusedId = contents(1); installWebSecurity(reusedId, 'whatsapp')
  assert.equal(check!(reusedId, 'media', reusedId.getURL(), media), false)
})
