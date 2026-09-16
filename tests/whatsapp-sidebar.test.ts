import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'
const { whatsappSidebarScript } = createRequire(import.meta.url)('../src/main/platforms/whatsapp/inject/sidebar.ts')

function fixture({ main = false, absolute = false, initial = 360, external = false } = {}) {
  const dom = new JSDOM(`<div id="layout" style="display:flex;flex-direction:row"><div id="column" style="position:static"><header>Chats</header><div id="side"></div></div><div id="${main ? 'main' : 'chat'}" ${absolute ? 'style="position:absolute"' : ''}></div></div>${external ? '<div id="portal"><div id="drawer" style="position:absolute;width:560px;display:none"></div></div>' : ''}`, { url: 'https://web.whatsapp.com', runScripts: 'outside-only', pretendToBeVisual: true })
  const w = dom.window as any, doc = w.document, column = doc.querySelector('#column'), side = doc.querySelector('#side'), content = doc.querySelector(main ? '#main' : '#chat'), root = doc.querySelector('#layout'), drawer = doc.querySelector('#drawer')
  const box = (left: number, width: number) => ({ left, right: left + width, top: 0, bottom: 600, width, height: 600 })
  const width = () => parseInt(column.style.width) || initial
  root.getBoundingClientRect = () => box(60, 960)
  column.getBoundingClientRect = side.getBoundingClientRect = () => box(60, width())
  content.getBoundingClientRect = () => box(60 + (absolute ? initial : width()), 960 - (absolute ? initial : width()))
  if (drawer) drawer.getBoundingClientRect = () => drawer.style.display === 'none' ? { ...box(0, 0), height: 0 } : box(60, parseInt(drawer.style.width) || 560)
  return { dom, w, doc, column, side, content, drawer, install: () => w.eval(whatsappSidebarScript), handle: () => doc.querySelector('[role=separator]') }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 65))

test('WhatsApp divider drags, clamps, remembers width and supports keyboard/reset', () => {
  const h = fixture(), { w, column } = h
  try {
    h.install(); const divider = h.handle(); assert.ok(divider)
    divider.dispatchEvent(new w.MouseEvent('pointerdown', { clientX: 420, button: 0, bubbles: true }))
    divider.dispatchEvent(new w.MouseEvent('pointermove', { clientX: 520, bubbles: true }))
    divider.dispatchEvent(new w.MouseEvent('pointerup', { bubbles: true }))
    assert.equal(column.style.width, '460px'); assert.equal(w.localStorage.getItem('hellodog:whatsapp-chat-list-width'), '460')
    divider.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); assert.equal(column.style.width, '444px')
    divider.dispatchEvent(new w.MouseEvent('pointerdown', { button: 0, bubbles: true })); divider.dispatchEvent(new w.MouseEvent('pointermove', { clientX: 10000, bubbles: true })); divider.dispatchEvent(new w.MouseEvent('pointerup', { bubbles: true })); assert.equal(column.style.width, '640px')
    divider.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true })); assert.equal(column.style.width, ''); assert.equal(w.localStorage.getItem('hellodog:whatsapp-chat-list-width'), null)
  } finally { h.dom.window.close() }
})

test('WhatsApp resize changes the full branch and inner list without creating a positioned ancestor', () => {
  const h = fixture({ main: true, initial: 440 })
  try {
    h.install(); const handle = h.handle(); assert.ok(handle)
    assert.equal(handle.parentElement, h.doc.body); assert.equal(handle.style.position, 'fixed')
    assert.equal(h.column.style.position, 'static'); assert.equal(handle.style.background, 'transparent'); assert.equal(handle.style.borderWidth, '0px')
    handle.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    assert.equal(h.column.style.width, '340px'); assert.equal(h.side.style.width, '100%'); assert.equal(handle.style.left, '397px')
    handle.dispatchEvent(new h.w.MouseEvent('dblclick', { bubbles: true })); assert.equal(h.side.style.width, ''); assert.equal(h.column.style.position, 'static'); assert.equal(handle.style.left, '497px')
  } finally { h.dom.window.close() }
})

test('saved width cannot leave a border across a separately positioned conversation', () => {
  const h = fixture({ main: true, absolute: true, external: true })
  try {
    h.w.localStorage.setItem('hellodog:whatsapp-chat-list-width', '560'); h.drawer.style.display = 'block'; h.install()
    assert.equal(h.column.style.width, ''); assert.equal(h.side.style.width, ''); assert.equal(h.column.style.position, 'static'); assert.equal(h.content.style.position, 'absolute'); assert.equal(h.handle(), null)
    assert.equal(h.drawer.style.width, '360px'); assert.equal(h.drawer.getBoundingClientRect().right, h.content.getBoundingClientRect().left)
  } finally { h.dom.window.close() }
})

test('external archive aligns on repeated style-only open and close without a saved width', async () => {
  const h = fixture({ main: true, external: true })
  try {
    h.install()
    for (let n = 0; n < 3; n++) {
      h.drawer.style.display = 'block'; await settle(); assert.equal(h.drawer.style.width, '360px')
      assert.equal(h.drawer.getBoundingClientRect().right, h.content.getBoundingClientRect().left)
      h.drawer.style.display = 'none'; await settle(); assert.equal(h.drawer.style.width, '560px'); assert.equal(h.handle().style.left, '417px')
    }
    assert.equal(h.w.localStorage.getItem('hellodog:whatsapp-chat-list-width'), null)
  } finally { h.dom.window.close() }
})

test('a platform style change is preserved when restoring the default width', () => {
  const h = fixture({ main: true })
  try {
    h.w.localStorage.setItem('hellodog:whatsapp-chat-list-width', '560'); h.install(); assert.equal(h.column.style.width, '560px')
    h.column.style.setProperty('width', '380px')
    h.handle().dispatchEvent(new h.w.MouseEvent('dblclick', { bubbles: true }))
    assert.equal(h.column.style.width, '380px'); assert.equal(h.column.style.getPropertyPriority('width'), '')
  } finally { h.dom.window.close() }
})

test('a removed resize overlay is recreated without waiting for a page reload',async()=>{
 const h=fixture();try{
  h.install();h.handle().remove();await settle();assert.ok(h.handle());assert.equal(h.doc.querySelectorAll('[role=separator]').length,1)
  h.handle().dispatchEvent(new h.w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));assert.equal(h.column.style.width,'376px')
 }finally{h.dom.window.close()}
})

test('initial nested width mismatch repairs the full branch without requiring a previously saved width',()=>{
 const h=fixture();try{
  h.side.getBoundingClientRect=()=>{const width=h.side.style.width==='100%'?(parseInt(h.column.style.width)||360):266;return{left:60,right:60+width,top:0,bottom:600,width,height:600}}
  h.install();assert.ok(h.handle());assert.equal(h.column.style.width,'266px');assert.equal(h.side.style.width,'100%');assert.equal(h.w.localStorage.getItem('hellodog:whatsapp-chat-list-width'),null)
  h.handle().dispatchEvent(new h.w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));assert.equal(h.column.style.width,'282px')
 }finally{h.dom.window.close()}
})

test('the same-row positioned conversation follows the sidebar and never leaves its old offset',()=>{
 const h=fixture({main:true,absolute:true});try{
  h.content.style.transform='none';Object.defineProperty(h.content,'offsetParent',{get:()=>h.column.parentElement})
  h.content.getBoundingClientRect=()=>{const offset=parseInt(h.content.style.left)||360;return{left:60+offset,right:1020,top:0,bottom:600,width:960-offset,height:600}}
  h.w.localStorage.setItem('hellodog:whatsapp-chat-list-width','480');h.install()
  assert.ok(h.handle());assert.equal(h.content.style.left,'480px');assert.equal(h.column.style.width,'480px')
  h.handle().dispatchEvent(new h.w.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));assert.equal(h.content.style.left,'464px')
 }finally{h.dom.window.close()}
})
