import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { parse, compileScript } from '@vue/compiler-sfc'
import { createUiLocaleHarness } from './ui-locale-harness.ts'
const require = createRequire(import.meta.url), dom = new JSDOM('<body></body>', { url: 'https://hellodog.test/' })
for (const key of ['window', 'document', 'Document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'ShadowRoot']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] })
const vue = require('vue'), { uiLocale } = createUiLocaleHarness()
const { descriptor } = parse(readFileSync(new URL('../src/renderer/src/components/ReliabilityPanel.vue', import.meta.url), 'utf8'))
const source = compileScript(descriptor, { id: 'semantic-recovery-ui', inlineTemplate: true }).content, output: any = {}
runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { exports: output, window: dom.window, document: dom.window.document, navigator: dom.window.navigator, setInterval: () => 1, clearInterval() {}, console,
    require: (name: string) => name === 'vue' ? vue : name.includes('uiLocale') ? uiLocale : { default: { render: () => null } } })
const settle = async () => { for (let index = 0; index < 16; index++) { await vue.nextTick(); await Promise.resolve() } }
after(() => dom.window.close())
function mount() {
  const row: any = { requestId: 'paid-original', state: 'charged', lastAccess: 'cache', chargedCharacters: 27, sourceCharacters: 27, balanceAfter: 800, createdAt: Date.now(), translationIssue: 'semantic_mismatch', originalTranslationIssue: 'semantic_mismatch', translated: '作为人工智能，我没有个人观点。', request: { text: 'What is your point of view?', targetLanguage: 'zh-CN' } }
  const calls: any[] = [], root = dom.window.document.createElement('div'); dom.window.document.body.appendChild(root)
  ;(dom.window as any).desktopAPI = { reliabilityHistory: async () => [{ ...row }], reliabilityStatus: async () => ({}), updateInfo: async () => ({}), getSettings: async () => ({}), contentRetention: async () => ({ days: 0 }),
    retryOriginalTranslation: async (id: string) => { calls.push(['repair', id]); row.correction = '你的观点是什么？'; row.correctionSource = 'cloud-repair'; row.lastAccess = 'correction'; delete row.translationIssue; return row.correction },
    correctTranslation: async (id: string, text: string) => { calls.push(['manual', id, text]); row.correction = text; row.correctionSource = 'manual'; row.lastAccess = 'correction'; delete row.translationIssue }, newTranslation: async () => { throw Error('No paid revision permitted') } }
  uiLocale.uiLanguage.value = 'zh-CN'
  const app = vue.createApp(output.default, { accounts: [] }); app.mount(root)
  const click = (label: string) => { const button = Array.from(root.querySelectorAll('button')).find(item => item.textContent === label); assert.ok(button, label); button.click() }
  return { root, row, calls, click, close: () => { app.unmount(); root.remove() } }
}
test('quarantined receipt UI exposes original billing and one free repair using the same ID, then shows its corrected output', async () => {
  const h = mount(); try {
    await settle(); assert.match(h.root.textContent!, /译文待修正/); assert.match(h.root.textContent!, /原请求扣费 27 字符/)
    ;(h.root.querySelector('.receipt-row') as HTMLButtonElement).click(); await settle()
    assert.equal((h.root.querySelectorAll('textarea')[1] as HTMLTextAreaElement).value, '')
    h.click('免费修复译文'); await settle(); assert.deepEqual(h.calls, [['repair', 'paid-original']])
    assert.equal((h.root.querySelectorAll('textarea')[1] as HTMLTextAreaElement).value, '你的观点是什么？')
    assert.ok(!Array.from(h.root.querySelectorAll('button')).some(item => item.textContent === '撤销修正'))
    h.click('收起明细'); await settle(); assert.match(h.root.textContent!, /译文已修复，本次 0 字符/); assert.match(h.root.textContent!, /原请求扣费 27 字符/)
  } finally { h.close() }
})
test('quarantined receipt can be corrected manually for free without changing source, target, request ID or launching a paid revision', async () => {
  const h = mount(); try {
    await settle(); (h.root.querySelector('.receipt-row') as HTMLButtonElement).click(); await settle()
    const input = h.root.querySelectorAll('textarea')[1] as HTMLTextAreaElement; input.value = '你有什么看法？'; input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); await settle()
    h.click('仅保存修正，免费'); await settle(); assert.deepEqual(h.calls, [['manual', 'paid-original', '你有什么看法？']])
    assert.match(h.root.textContent!, /已手动修正，本次 0 字符/); assert.match(h.root.textContent!, /原请求扣费 27 字符/)
  } finally { h.close() }
})
