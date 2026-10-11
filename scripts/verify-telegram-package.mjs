import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import * as path from 'node:path'
import * as url from 'node:url'
import { runInNewContext } from 'node:vm'

// Inspect the actual application archive and execute selected packaged account
// and origin functions against synthetic in-memory records only. Never launch
// the installed client, open its profile, migrate accounts or contact Telegram.
const root = url.fileURLToPath(new URL('../', import.meta.url)), output = process.argv[2]
assert.ok(output, 'Provide directory containing win-unpacked')
const require = createRequire(import.meta.url), builder = createRequire(require.resolve('electron-builder'))
const asar = createRequire(builder.resolve('app-builder-lib'))('@electron/asar'), ts = require('typescript')
const archive = resolve(output, 'win-unpacked/resources/app.asar')
const files = asar.listPackage(archive).filter(file => /\.(?:js|json|html|svg|css)$/.test(file))
const extract = name => asar.extractFile(archive, join(...name.split(/[\\/]+/).filter(Boolean)))
const source = name => extract(name).toString('utf8')
const main = source('out/main/index.js'), telegram = source('out/preload/telegram.js'), hostPreload = source('out/preload/index.js')
const rendererFiles = files.filter(name => /out[\\/]renderer[\\/]assets[\\/]index-[^\\/]+\.js$/.test(name))
assert.ok(rendererFiles.length, 'Main renderer bundle is absent')
const renderer = rendererFiles.map(source).join('\n')
const digest = value => createHash('sha256').update(value).digest('hex')
const buildFiles = ['out/main/index.js', 'out/preload/index.js', 'out/preload/telegram.js', 'out/preload/whatsapp.js', 'out/preload/googleVoice.js', ...rendererFiles]
for (const name of buildFiles) assert.equal(digest(extract(name)), digest(await readFile(join(root, ...name.split(/[\\/]+/).filter(Boolean)))), 'Package differs from tested build: ' + name)
for (const platform of ['whatsapp', 'signal', 'telegram', 'google-voice']) assert.ok(source('out/renderer/' + platform + '.svg').includes('<svg'), 'Missing application icon: ' + platform)
for (const marker of ['Telegram', 'telegram.svg', 'WhatsApp', 'Signal', 'addAccounts', 'testAccountProxy', 'focusPlatform']) assert.ok(renderer.includes(marker), 'Missing renderer entry: ' + marker)
for (const marker of ['telegram:edit-composer', 'telegram:connection', 'telegram:conversation', 'telegram:unread', 'voice:translate-message', 'send:prepare', 'send:submit', 'translator:send-guard-ready']) assert.ok(telegram.includes(marker), 'Missing Telegram preload bridge: ' + marker)
for (const marker of ['englishTranslation', 'hd-tg-voice', '__RT_SEND_COMMIT__', 'voice-en-', 'telegram:']) assert.ok(main.includes(marker), 'Missing packaged Telegram/voice behavior: ' + marker)
assert.ok(hostPreload.includes('ui:account-action'), 'Host preload omits embedded-page load state')

const ast = ts.createSourceFile('packaged-main.js', main, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
function declaration(name) {
  const node = ast.statements.find(node => (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === name)
  assert.ok(node, 'Missing packaged declaration: ' + name)
  return node.getText(ast)
}
const policy = runInNewContext([declaration('isTelegramUrl'), declaration('isTelegramOrigin'), '({isTelegramUrl,isTelegramOrigin})'].join('\n'), { URL })
for (const value of ['https://web.telegram.org/a/', 'https://web.telegram.org/a/#123', 'https://web.telegram.org/a']) assert.equal(policy.isTelegramUrl(value), true, value)
for (const value of ['http://web.telegram.org/a/', 'https://web.telegram.org/k/', 'https://web.telegram.org/', 'https://web.telegram.org.evil.invalid/a/', 'https://evil.invalid/a/', 'https://user:password@web.telegram.org/a/', 'file:///a/']) assert.equal(policy.isTelegramUrl(value), false, value)
assert.equal(policy.isTelegramOrigin('https://web.telegram.org'), true)
assert.equal(policy.isTelegramOrigin('https://web.telegram.org.evil.invalid'), false)

const telegramClass = declaration('TelegramAdapter')
for (const marker of ['persist:telegram:', '../preload/telegram.js', 'https://web.telegram.org/a/', 'installWebSecurity', 'ui:account-action', 'page-${state}']) assert.ok(telegramClass.includes(marker), 'Missing adapter isolation/load state: ' + marker)
const constructed = [], secured = []
class FakeWebContentsView {
  constructor(options) {
    constructed.push(options)
    this.webContents = { on() {}, setUserAgent() {}, session: { setUserAgent() {}, webRequest: { onBeforeSendHeaders() {} } } }
  }
}
const PackagedTelegram = runInNewContext(telegramClass + '\nTelegramAdapter', {
  electron: { app: { on() {} }, WebContentsView: FakeWebContentsView }, path$1: path, path,
  chromeUserAgent: () => 'Synthetic verifier', setAccountState() {}, installWebSecurity: (_contents, kind) => secured.push(kind),
  __dirname: resolve(root, 'out/main')
})
const adapter = new PackagedTelegram()
adapter.createView('synthetic-account-a'); adapter.createView('synthetic-account-b')
assert.deepEqual(secured, ['telegram', 'telegram'])
assert.notEqual(constructed[0].webPreferences.partition, constructed[1].webPreferences.partition)
for (const [index, item] of constructed.entries()) {
  const preferences = item.webPreferences
  assert.equal(preferences.partition, 'persist:telegram:synthetic-account-' + (index ? 'b' : 'a'))
  assert.equal(preferences.contextIsolation, true); assert.equal(preferences.sandbox, true); assert.equal(preferences.nodeIntegration, false)
  assert.ok(preferences.preload.endsWith(join('preload', 'telegram.js')))
}

// Existing three-platform account records must survive creating/removing one
// additional Telegram account. This executes the class from app.asar with an
// in-memory JsonStore; it cannot read or write user account files.
const original = [
  { id: 'wa-existing', platform: 'whatsapp', label: 'Synthetic WhatsApp', createdAt: 1, translationProvider: 'deepseek', proxy: { enabled: true, protocol: 'http', host: 'proxy.invalid', port: 8080 }, proxySecret: 'synthetic-encrypted-value', contactLanguages: { peer: { language: 'en-US' } } },
  { id: 'signal-existing', platform: 'signal', label: 'Synthetic Signal', signalEngine: 'desktop', createdAt: 2, contactLanguages: {} },
  { id: 'telegram-existing', platform: 'telegram', label: 'Synthetic Telegram', createdAt: 3, translationProvider: 'openai', runtimeMode: 'paused', contactLanguages: { 'telegram:123:0': { language: 'fr' } } }
]
let records = structuredClone(original), writes = 0
const PackagedAccounts = runInNewContext(declaration('AccountManager') + '\nAccountManager', {
  JsonStore: class { async read() { return structuredClone(records) } async write(value) { records = structuredClone(value); writes++ } },
  crypto: { randomUUID }, randomUUID
})
const accounts = new PackagedAccounts(), listed = await accounts.list()
assert.deepEqual(Array.from(listed, record => record.platform), ['whatsapp', 'signal', 'telegram'])
assert.equal(writes, 0); assert.deepEqual(records, original)
assert.equal(Object.hasOwn(listed[0], 'proxySecret'), false)
const added = await accounts.add('telegram', 'Synthetic extra Telegram')
assert.equal(added.platform, 'telegram'); assert.equal(added.sendAutoTranslate, true); assert.equal(added.blockChineseSend, true)
assert.deepEqual(records.slice(0, 3), original)
await accounts.remove(added.id); assert.deepEqual(records, original)

assert.ok(!asar.listPackage(archive).some(name => /(?:^|[\\/])\.env(?:\.|$)/.test(name)), 'An environment file is embedded')
for (const name of files.filter(name => /\.(?:js|json|html)$/.test(name))) assert.ok(!/\b(?:sk-(?:proj-|admin-)?|sb_secret_)[A-Za-z0-9_-]{24,}/.test(source(name)), 'A provider secret is embedded in ' + name)
const version = JSON.parse(source('package.json')).version
assert.equal(version, JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version)
console.log(JSON.stringify({ passed: true, version, archive, testedBuildFilesMatch: buildFiles.length, telegramPreload: true,
  officialWebAOriginRestriction: true, isolatedSandboxedPartitions: true, rendererEntriesAndIcons: true,
  existingThreePlatformRecordsPreservedInSyntheticStore: true, providerSecretsAbsent: true,
  actualUserProfilesAccessed: false, realAccountsAccessed: false, cloudRequests: 0, officialPageSmoke: 'not run', localOnly: true }))
