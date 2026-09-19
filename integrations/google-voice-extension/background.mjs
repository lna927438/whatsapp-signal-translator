import { NativeClient, NativeBusyError, selectedContext, digest } from './protocol.mjs'
import { ExtensionBridge, SelectionTasks } from './background-core.mjs'

const ready = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
const bridge = new ExtensionBridge({ native: new NativeClient(chrome.runtime), storage: chrome.storage.local, runtime: chrome.runtime })
const selections = new SelectionTasks()
async function announceConnectionChange() {
  const tabs = await chrome.tabs.query({ url: 'https://voice.google.com/*' })
  await Promise.allSettled(tabs.map(tab => chrome.tabs.sendMessage(tab.id, { v: 1, type: 'voice.connection-changed' }, { frameId: 0 })))
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  ready.then(() => bridge.handle(message, sender)).then(result => {
    if (message.type === 'pair' || message.type === 'disconnect') { selections.clear(); void announceConnectionChange().catch(() => {}) }
    reply({ ok: true, result })
  }, error => reply({ ok: false, code: error instanceof NativeBusyError ? 'busy' : 'failed', error: error instanceof NativeBusyError ? error.message : '无法完成操作，请检查 HelloDog 连接、余额和发送记录。' }))
  return true
})
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'hellodog-translate-selection', title: '使用 HelloDog 翻译选中文字', contexts: ['selection'], documentUrlPatterns: ['https://voice.google.com/*'] })
  })
})
chrome.contextMenus.onClicked.addListener((info, tab) => {
  const selection = selectedContext(info, tab)
  if (!selection) return
  const sourceUrl = selection.url, id = crypto.randomUUID()
  let ticket, scope
  const show = async payload => {
    // Recheck the tab after the asynchronous provider call; never disclose text
    // into a navigated page or a different document/tab.
    const current = await chrome.tabs.get(tab.id)
    if (current.url !== sourceUrl) return
    await chrome.tabs.sendMessage(tab.id, { v: 1, type: 'selection.result', id, ticket, ...payload }, { frameId: 0 })
  }
  void ready.then(async () => {
    const opened = await chrome.tabs.sendMessage(tab.id, { v: 1, type: 'selection.open', id }, { frameId: 0 })
    if (!opened || typeof opened.ticket !== 'string') throw new Error('页面尚未准备好。')
    ticket = opened.ticket
    scope = await bridge.selectionScope()
    const key = await digest(JSON.stringify([scope.key, selection.text]))
    const started = await chrome.tabs.sendMessage(tab.id, { v: 1, type: 'selection.begin', id, key }, { frameId: 0 })
    if (!started || typeof started.ticket !== 'string' || typeof started.logicalId !== 'string') throw new Error('页面尚未准备好。')
    if (ticket !== started.ticket) throw new Error('页面已经变化。')
    const result = await selections.run({ tabId: tab.id, ticket, key, id: started.logicalId }, businessId => scope.translate(selection.text, sourceUrl, businessId))
    if (!await scope.current()) throw new Error('连接已变化。')
    return result
  })
    .then(result => show({ text: result.text }), error => show({ error: error instanceof NativeBusyError ? error.message : '翻译尚未完成，原消息未改动。同一页面的同一选择保留原任务编号，不会自动重试或发送。请查看 HelloDog 的登录、网络和字符余额。' }))
    .catch(() => { /* A closed/navigated tab cannot receive results. No replay. */ })
})
chrome.tabs.onRemoved.addListener(tabId => selections.clear(tabId))
chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.status === 'loading' || change.url) selections.clear(tabId) })
