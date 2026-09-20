import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url)), require = createRequire(resolve(root, 'package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const { chromium } = require('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const folder = resolve(root, 'verification/google-voice-unread-20260920')
await mkdir(folder, { recursive: true })
// Playwright's temporary browser profile also stays on D:, without using a real profile.
process.env.TEMP = 'D:/UserAppData/Temp'; process.env.TMP = 'D:/UserAppData/Temp'
const bundle = (await build({ entryPoints: [resolve(root, 'src/preload/googleVoiceUnread.ts')], bundle: true,
  write: false, platform: 'browser', format: 'iife', globalName: 'GoogleVoiceUnreadFixture', target: 'es2022' })).outputFiles[0].text
const fixtureUrl = 'https://voice.google.com/__hellodog_unread_fixture__'
const otherUrl = 'https://fixture.example.invalid/unread'
const checks = [], pageErrors = [], network = { syntheticDocuments: 0, blocked: 0 }
const badge = value => value === 'hidden' ? '<mat-icon class="mat-badge mat-badge-hidden">message</mat-icon>'
  : `<mat-icon class="mat-badge">message<span id="mat-badge-content-1" aria-hidden="true" class="mat-badge-content mat-badge-active">${value}</span></mat-icon>`
const messages = (content, style = '') => `<a role="tab" gv-test-id="sidenav-messages" style="${style}">${content}<span>Messages</span></a>`
const nav = contents => `<mat-nav-list>${contents}</mat-nav-list>`
const observedPositive = nav('<a role="tab" gv-test-id="sidenav-messages" aria-label="Messages: 1 unread">' + badge('1') + '<span>Messages</span></a>')
const unrelated = '<section id="contacts">Synthetic contact 2025550123</section><article id="message-body">Synthetic message body: 42 reminders and 9988 tokens.</article>'
const shell = `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic unread fixture</title><style>
body{font:16px Arial;padding:24px}mat-nav-list{display:block}a[role=tab]{display:inline-flex;gap:12px;padding:12px}
mat-icon{display:inline-block}.mat-badge-content{display:inline-block;margin-left:8px;padding:2px 6px;background:#dce8ff}
.mat-badge-hidden .mat-badge-content{display:none}h1{font-size:20px}#fixture{border:1px solid #bbb;padding:16px}
</style></head><body><h1>Synthetic fixture using observed badge markup</h1><p>Real Google Voice notification delivery is not exercised.</p><main id="fixture"></main></body></html>`
let browser, context, failure
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  context = await browser.newContext({ viewport: { width: 1120, height: 720 }, serviceWorkers: 'block', permissions: [] })
  await context.route('**/*', route => {
    if ([fixtureUrl, otherUrl].includes(route.request().url()) && route.request().isNavigationRequest()) {
      network.syntheticDocuments++; return route.fulfill({ contentType: 'text/html', body: shell })
    }
    network.blocked++; return route.abort()
  })
  const prepare = async (html, url = fixtureUrl) => {
    const page = await context.newPage()
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.goto(url)
    await page.locator('#fixture').evaluate((node, value) => { node.innerHTML = value }, html)
    await page.addScriptTag({ content: bundle })
    return page
  }
  const replace = (page, html) => page.locator('#fixture').evaluate((node, value) => { node.innerHTML = value }, html)
  const read = page => page.evaluate(() => GoogleVoiceUnreadFixture.readGoogleVoiceUnread(document))
  const install = page => page.evaluate(() => {
    window.__reports = []
    window.__dispose = GoogleVoiceUnreadFixture.installGoogleVoiceUnread(document, async value => {
      window.__reports.push(structuredClone(value)); return true
    })
  })
  const counts = page => page.evaluate(() => window.__reports.map(value => value.count))
  const waitForReports = (page, length) => page.waitForFunction(expected => window.__reports.length === expected, length, { timeout: 5000 })

  const reader = await prepare('')
  const readerCases = [
    ['observed hidden Messages Material badge is zero', nav(messages(badge('hidden'))), 0, 'observed-zero-shape'],
    ['hidden duplicate Messages navigation preserves known zero', nav(messages(badge('hidden'), 'display:none') + messages(badge('hidden'))), 0, 'observed-zero-shape'],
    ['observed active positive badge is readable even with aria-hidden=true', observedPositive, 1, 'observed-positive-shape'],
    ['one rendered integer badge is a candidate positive count', nav(messages(badge('7'))), 7],
    ['hidden duplicate Messages navigation preserves a candidate count', nav(messages(badge('91'), 'display:none') + messages(badge('7'))), 7],
    ['largest exact supported count remains numeric', nav(messages(badge('99999'))), 99999],
    ['unknown navigation is unavailable', '<div>Messages 8</div>', null],
    ['Messages navigation without a badge is unavailable', nav(messages('<mat-icon>message</mat-icon>')), null],
    ['two visible Messages navigations are ambiguous', nav(messages(badge('2')) + messages(badge('4'))), null],
    ['two visible Material badges are ambiguous', nav(messages(badge('2') + badge('4'))), null],
    ['two count elements in one badge are ambiguous', nav(messages('<mat-icon class="mat-badge"><span class="mat-badge-content mat-badge-active">2</span><span class="mat-badge-content mat-badge-active">4</span></mat-icon>')), null],
    ['abbreviated 99+ is unavailable rather than guessed', nav(messages(badge('99+'))), null],
    ['decorated count text is unavailable', nav(messages(badge('7 unread'))), null],
    ['out of range integers are unavailable', nav(messages(badge('100000'))), null],
    ['a leading-zero number is not a count candidate', nav(messages(badge('007'))), null],
    ['inactive Material count element is unavailable', nav(messages('<mat-icon class="mat-badge"><span class="mat-badge-content">7</span></mat-icon>')), null],
    ['hidden count element is unavailable', nav(messages('<mat-icon class="mat-badge"><span class="mat-badge-content mat-badge-active" style="display:none">7</span></mat-icon>')), null],
    ['visibility-hidden count element is unavailable', nav(messages('<mat-icon class="mat-badge"><span class="mat-badge-content mat-badge-active" style="visibility:hidden">7</span></mat-icon>')), null],
    ['only a hidden Messages navigation is unavailable', nav(messages(badge('hidden'), 'display:none')), null],
    ['busy navigation cannot publish a new count', '<div aria-busy="true">' + nav(messages(badge('hidden'))) + '</div>', null],
    ['contacts and message-body numbers are ignored', unrelated, null],
    ['Calls navigation cannot supply Messages unread', nav('<a role="tab" gv-test-id="sidenav-calls">' + badge('81') + 'Calls</a>') + unrelated, null],
    ['Calls and body numbers cannot override Messages zero', nav(messages(badge('hidden')) + '<a role="tab" gv-test-id="sidenav-calls">' + badge('81') + 'Calls</a>') + unrelated, 0],
  ]
  for (const [name, html, expected, evidence = 'candidate-semantic-fixture'] of readerCases) {
    await replace(reader, html); assert.equal(await read(reader), expected, name)
    checks.push({ name, passed: true, evidence })
  }
  await replace(reader, observedPositive + unrelated)
  await reader.screenshot({ path: resolve(folder, 'synthetic-observed-badge.png') })
  await reader.close()

  const observed = await prepare(nav(messages(badge('hidden'))) + unrelated)
  await install(observed); await waitForReports(observed, 1)
  assert.deepEqual(await counts(observed), [0])
  await replace(observed, nav(messages(badge('3'))) + unrelated); await waitForReports(observed, 2)
  await observed.evaluate(() => {
    for (let i = 0; i < 5; i++) document.querySelector('#message-body').textContent = 'Synthetic unrelated body number ' + i
  })
  await observed.waitForTimeout(1100)
  assert.deepEqual(await counts(observed), [0, 3])
  checks.push({ name: 'initial zero and stable positive change are each reported once; unrelated mutations do not duplicate', passed: true })

  // Keep the transient shape through one sample but restore it before stability.
  await replace(observed, nav(messages(badge('hidden'))) + unrelated); await observed.waitForTimeout(425)
  await replace(observed, nav(messages(badge('3'))) + unrelated); await observed.waitForTimeout(1100)
  assert.deepEqual(await counts(observed), [0, 3])
  await replace(observed, unrelated); await observed.waitForTimeout(425)
  await replace(observed, nav(messages(badge('3'))) + unrelated); await observed.waitForTimeout(1100)
  assert.deepEqual(await counts(observed), [0, 3])
  checks.push({ name: 'short hidden-badge and removed-navigation redraws publish neither false zero nor unavailable', passed: true })

  await replace(observed, unrelated); await waitForReports(observed, 3)
  assert.deepEqual(await counts(observed), [0, 3, null])
  await replace(observed, nav(messages(badge('9'))) + unrelated); await waitForReports(observed, 4)
  const payloads = await observed.evaluate(() => window.__reports)
  assert.deepEqual(payloads.map(value => value.sequence), [1, 2, 3, 4])
  assert.equal(new Set(payloads.map(value => value.documentId)).size, 1)
  for (const value of payloads) {
    assert.deepEqual(Object.keys(value).sort(), ['count', 'documentId', 'sequence', 'source'])
    assert.equal(value.source, 'sms-navigation'); assert.match(value.documentId, /^[0-9a-f-]{36}$/)
  }
  assert.doesNotMatch(JSON.stringify(payloads), /Synthetic|2025550123|9988|reminders/)
  checks.push({ name: 'stable unknown reports null, recovery reports a count, and payload contains only source/documentId/sequence/count', passed: true })

  await observed.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })))
  await replace(observed, nav(messages(badge('11'))) + unrelated); await observed.waitForTimeout(1100)
  assert.deepEqual(await counts(observed), [0, 3, null, 9])
  checks.push({ name: 'pagehide disconnects the observer and prevents further reports', passed: true })
  await observed.close()

  const disposed = await prepare(nav(messages(badge('2'))))
  await install(disposed); await waitForReports(disposed, 1); await disposed.evaluate(() => window.__dispose())
  await replace(disposed, nav(messages(badge('4')))); await disposed.waitForTimeout(1100)
  assert.deepEqual(await counts(disposed), [2])
  checks.push({ name: 'explicit disposal prevents later DOM changes from reporting', passed: true })
  await disposed.close()

  const pending = await prepare(nav(messages(badge('5'))))
  await pending.evaluate(() => {
    window.__reports = []
    window.__dispose = GoogleVoiceUnreadFixture.installGoogleVoiceUnread(document, value => {
      window.__reports.push(structuredClone(value)); return new Promise(resolve => { window.__resolveReport = resolve })
    })
  })
  await waitForReports(pending, 1)
  await pending.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }))
    document.querySelector('.mat-badge-content').textContent = '6'; window.__resolveReport(true)
  })
  await pending.waitForTimeout(1100); assert.deepEqual(await counts(pending), [5])
  checks.push({ name: 'an in-flight report completing after pagehide cannot restart observation', passed: true })
  await pending.close()

  const wrongOrigin = await prepare(nav(messages(badge('2'))), otherUrl)
  await install(wrongOrigin); await wrongOrigin.waitForTimeout(1100)
  assert.deepEqual(await counts(wrongOrigin), [])
  checks.push({ name: 'installer refuses a non-Voice origin', passed: true })
  await wrongOrigin.close()
  assert.deepEqual(pageErrors, [])
} catch (error) {
  failure = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) }
} finally {
  const report = { passed: !failure, at: new Date().toISOString(), realBrowser: 'headless Microsoft Edge', browserVersion: browser?.version(),
    scope: 'Real readGoogleVoiceUnread and installGoogleVoiceUnread bundled into isolated synthetic documents; every network request is intercepted.',
    positiveCountEvidence: 'The coordinating agent supplied read-only official-page observation of Messages: 1 unread with a visible mat-badge-active span, id mat-badge-content-1 and aria-hidden=true. This run reproduces that structure synthetically; it does not verify real client notification delivery.',
    observedShapeEvidence: 'Hidden zero Material badge, hidden duplicate Messages navigation and active positive badge supplied from read-only official-page observations by the coordinating agent.',
    syntheticOnly: true, realGoogleVoiceAccounts: false, realSmsSent: 0, realSystemNotifications: 0, network,
    limitations: ['Browser execution uses synthetic markup even where the structure matches read-only official-page observations.', 'Does not exercise Electron IPC or main-process notification delivery.'], checks, pageErrors, ...(failure ? { failure } : {}) }
  await writeFile(resolve(folder, 'browser-results.json'), JSON.stringify(report, null, 2) + '\n')
  await browser?.close()
  console.log(JSON.stringify({ passed: report.passed, checks: checks.length, pageErrors: pageErrors.length, evidence: folder, ...(failure ? { failure: failure.message } : {}) }))
  process.exitCode = failure ? 1 : 0
}
