import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// Exercise the real Signal preload, UI, decoder and Electron IPC in Signal's
// own Electron version. No Signal account, network, microphone, ASR or provider.
// Signal's real loadData implementation hydrates synthetic attachment bytes;
// attachment filesystem decryption is deliberately outside this fixture.
const require = createRequire(import.meta.url)
const { _electron } = require('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const root = fileURLToPath(new URL('../', import.meta.url))
const argument = process.argv.find(value => value.startsWith('--checkout='))
assert.ok(argument, 'Pass the Signal source checkout explicitly')
const checkout = resolve(argument.slice('--checkout='.length))
const scratch = 'D:/UserAppData/Temp/hellodog-signal-voice-preload'
await mkdir(scratch, { recursive: true })
const directory = await mkdtemp(join(scratch, 'probe-'))
const html = await readFile(join(checkout, 'background.html'), 'utf8')
const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1].replace(/\s+/g, ' ').trim()
assert.ok(csp)
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const sources = {}
for (const [key, path] of [
  ['ui', 'integrations/hellodog-source/hellodog.voice.dom.ts'],
  ['preload', 'integrations/hellodog-source/hellodog.voice.preload.ts'],
  ['audio', 'src/shared/voiceAudio.ts'],
  ['request', 'src/main/platforms/signal/signalDesktopVoice.ts'],
]) sources[key] = compile(await readFile(join(root, path), 'utf8'))
const attachmentSource = await readFile(join(checkout, 'ts/util/Attachment.std.ts'), 'utf8')
const attachmentAst = ts.createSourceFile('Attachment.std.ts', attachmentSource, ts.ScriptTarget.Latest, true)
const attachmentFunctions = ['isValid', 'loadData'].map(name => {
  const node = attachmentAst.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name)
  assert.ok(node, 'Missing upstream ' + name)
  return node.getText(attachmentAst)
}).join('\n')
sources.loader = compile('const { isFunction, isString } = require(' + JSON.stringify(join(checkout, 'node_modules/lodash')) + ');\n' + attachmentFunctions)
const commonLoader = `function load(source, overrides = {}) { const exports = {}; new Function('exports', 'require', source)(exports, name => Object.hasOwn(overrides, name) ? overrides[name] : require(name)); return exports; }`
const cases = [
  { name: '18-second-in-memory-wav', type: 'audio/wav', mode: 'memory' },
  { name: '18-second-hydrated-wav', type: 'audio/wav', mode: 'path' },
  { name: 'signal-public-ogg', type: 'audio/ogg', mode: 'path', fixture: join(checkout, 'sounds/notification.ogg') },
  { name: 'signal-public-mp3', type: 'audio/mpeg', mode: 'path', fixture: join(checkout, 'fixtures/incompetech-com-Agnus-Dei-X.mp3') },
  { name: 'invalid-audio-rejected', type: 'audio/wav', mode: 'path', invalid: true },
]
await writeFile(join(directory, 'fixture.html'), '<!doctype html><meta http-equiv="Content-Security-Policy" content="' + csp + '"><body><div data-hellodog-id="message-a"><div class="module-message__container"></div></div></body>')
await writeFile(join(directory, 'preload.cjs'), `
const { ipcRenderer, contextBridge } = require('electron');
const fs = require('node:fs');
${commonLoader}
const sources = ${JSON.stringify(sources)};
const config = ${JSON.stringify(cases)}[Number(process.env.PROBE_CASE)];
let attachmentReads = 0, plays = 0, recordings = 0;
HTMLMediaElement.prototype.play = function () { plays++; throw new Error('Playback forbidden'); };
if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { recordings++; throw new Error('Recording forbidden'); };
function wav() {
  const samples = 18 * 16000, bytes = new Uint8Array(44 + samples * 2), view = new DataView(bytes.buffer);
  for (const [at, value] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']]) for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i);
  view.setUint32(4, bytes.length - 8, true); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.round(Math.sin(i * 0.09) * 12000), true);
  return bytes;
}
const bytes = config.invalid ? new Uint8Array([1, 2, 3]) : config.fixture ? new Uint8Array(fs.readFileSync(config.fixture)) : wav();
const attachment = { contentType: config.type, size: bytes.length, ...(config.mode === 'memory' ? { data: bytes } : { path: 'synthetic-owned-attachment' }) };
const message = { get(key) { return ({ conversationId: 'conversation-a', attachments: [attachment] })[key]; } };
window.MessageCache = { getById: id => id === 'message-a' ? message : undefined };
window.reduxStore = { getState: () => ({}) };
const loadAttachmentData = load(sources.loader).loadData(async owned => {
  attachmentReads++;
  if (owned !== attachment || owned.path !== 'synthetic-owned-attachment') throw new Error('Not the owned attachment');
  return bytes;
});
const ui = load(sources.ui), audio = load(sources.audio);
const wrappedUi = { createSignalVoiceUi(deps) { return ui.createSignalVoiceUi({ ...deps, translate: async (...args) => {
  try { return await deps.translate(...args); }
  catch (error) { ipcRenderer.send('probe-error', { name: error.name, message: error.message }); throw error; }
} }); } };
load(sources.preload, {
  '../util/migrations.preload.ts': { loadAttachmentData },
  '../state/selectors/nav.std.ts': { getSelectedConversationId: () => 'conversation-a' },
  './hellodog.voice-audio.std.ts': audio,
  './hellodog.voice.dom.ts': wrappedUi,
}).startHelloDogVoiceMessages();
contextBridge.exposeInMainWorld('probe', { snapshot: () => ({ attachmentReads, plays, recordings, inputBytes: bytes.length }) });
`)
await writeFile(join(directory, 'main.cjs'), `
const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('node:path');
${commonLoader}
const sources = ${JSON.stringify(sources)};
const audio = load(sources.audio);
const { decodeSignalVoiceRequest } = load(sources.request, { '../../../shared/voiceAudio': audio });
app.setPath('userData', path.join(__dirname, 'profile-' + process.env.PROBE_CASE));
global.probeResults = { invocations: 0, errors: [], networkRequests: 0, electron: process.versions.electron };
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, done) => { global.probeResults.networkRequests++; done({ cancel: true }); });
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, nodeIntegrationInWorker: false, sandbox: false, contextIsolation: true, preload: path.join(__dirname, 'preload.cjs') } });
  ipcMain.on('probe-error', (_event, value) => global.probeResults.errors.push(value));
  ipcMain.handle('hellodog:voice', (event, raw) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Wrong IPC sender');
    const request = decodeSignalVoiceRequest(raw);
    global.probeResults.invocations++;
    global.probeResults.wavBytes = request.bytes.length;
    return { text: 'Synthetic recognition placeholder',englishTranslation:'Synthetic recognition placeholder', translation: '测试中文译文', audioId: 'a'.repeat(64), targetLanguage: 'zh-CN' };
  });
  win.loadFile(path.join(__dirname, 'fixture.html'));
});
`)
const checks = []
for (const [index, config] of cases.entries()) {
  const electron = await _electron.launch({ executablePath: join(checkout, 'node_modules/electron/dist/electron.exe'), args: [join(directory, 'main.cjs')], env: { ...process.env, TEMP: 'D:/UserAppData/Temp', TMP: 'D:/UserAppData/Temp', HELLODOG_EMBEDDED: '1', HELLODOG_BRIDGE_ACTIVE: '1', PROBE_CASE: String(index) }, timeout: 30000 })
  try {
    const page = await electron.firstWindow()
    await page.getByRole('button', { name: '转为中文', exact: true }).waitFor()
    assert.equal((await electron.evaluate(() => global.probeResults)).invocations, 0)
    assert.equal((await page.evaluate(() => window.probe.snapshot())).attachmentReads, 0)
    await page.getByRole('button', { name: '转为中文', exact: true }).click()
    if(config.invalid)await page.getByRole('button', { name: '重试语音翻译', exact: true }).waitFor({ timeout: 30000 });else await page.locator('[aria-label="中文译文"]').waitFor({timeout:30000})
    const result = await electron.evaluate(() => global.probeResults)
    const snapshot = await page.evaluate(() => ({ ...window.probe.snapshot(), requireType: typeof window.require }))
    assert.equal(result.invocations, config.invalid ? 0 : 1)
    assert.equal(result.networkRequests, 0)
    assert.equal(snapshot.plays, 0)
    assert.equal(snapshot.recordings, 0)
    assert.equal(snapshot.requireType, 'undefined')
    assert.equal(snapshot.attachmentReads, config.mode === 'memory' ? 0 : 1)
    if (!config.invalid) {
      assert.deepEqual(result.errors, [])
      assert.match(await page.locator('[aria-label="中文译文"]').textContent(), /测试中文译文/)
      assert.equal(await page.locator('[aria-label="英文译文"]').textContent(),'Synthetic recognition placeholder')
      if (!config.fixture) assert.equal(result.wavBytes, 576044)
    } else {
      assert.equal(result.errors.length, 1)
      assert.doesNotMatch(await page.locator('[role=status]').textContent(), /EncodingError|decodeAudioData/)
    }
    checks.push({ name: config.name, ...snapshot, ...result })
  } finally { await electron.close() }
}
const result = { passed: true, at: new Date().toISOString(), checkout, directory, checks, syntheticOrPublicFixturesOnly: true, nativeAttachmentDecryptionTested: false, recognitionMocked: true, providerCalls: 0, realChatSends: 0 }
await writeFile(join(directory, 'results.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result))
