const { app, BrowserWindow, net, session } = require('electron')
const assert = require('node:assert/strict')
const http = require('node:http'), https = require('node:https'), tcp = require('node:net')
const { readFileSync, writeFileSync, mkdtempSync } = require('node:fs')
const { join } = require('node:path'), { randomUUID, X509Certificate } = require('node:crypto')
const output = process.argv[2], checks = [], servers = [], windows = [], sockets = new Set()
app.setPath('userData', mkdtempSync('D:/UserAppData/Temp/hellodog-voice-network-'))
app.commandLine.appendSwitch('disable-background-networking')
// A missing proxy cannot ever reach a public origin, even if the code regresses.
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * 127.0.0.1, EXCLUDE localhost')
app.on('window-all-closed', () => {})
const identity = { key: readFileSync(join(output, 'fixture-key.pem')), cert: readFileSync(join(output, 'fixture-cert.pem')) }
const fingerprint = new X509Certificate(identity.cert).fingerprint256
function track(server) { servers.push(server); server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {}) }); return server }
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port }
function trustFixture(ses) {
  ses.setCertificateVerifyProc((details, callback) => {
    let matching = false
    try { matching = ['api.ipify.org', '127.0.0.1'].includes(details.hostname) && new X509Certificate(details.certificate.data).fingerprint256 === fingerprint } catch {}
    callback(matching ? 0 : -3)
  })
}
function isolated(label, trust = true) { const ses = session.fromPartition('voice-network-fixture-' + label + '-' + randomUUID(), { cache: false }); if (trust) trustFixture(ses); return ses }
async function makeProxy(ip, username, password) {
  const stats = { challenges: 0, supplied: 0, accepted: 0, requests: 0, cookieHeaders: 0, originAuthHeaders: 0, foreignTargets: 0 }
  const backend = track(https.createServer(identity, (request, response) => {
    stats.requests++; if (request.headers.cookie) stats.cookieHeaders++; if (request.headers.authorization) stats.originAuthHeaders++
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' }); response.end(JSON.stringify({ ip }))
  }))
  const backendPort = await listen(backend)
  const proxy = track(http.createServer((_request, response) => { response.writeHead(400, { connection: 'close' }); response.end() }))
  const expected = 'Basic ' + Buffer.from(username + ':' + password).toString('base64')
  const localTargets = new Set(['api.ipify.org:443'])
  proxy.on('connect', (request, socket, head) => {
    if (!localTargets.has(request.url)) { stats.foreignTargets++; console.log('fixture refused unrelated CONNECT', request.url); socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return }
    const supplied = request.headers['proxy-authorization']; if (supplied) stats.supplied++
    if (supplied !== expected) { stats.challenges++; socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="synthetic-fixture"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return }
    stats.accepted++
    const upstream = tcp.connect(backendPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket)
    })
    sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream))
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy())
  })
  const port = await listen(proxy)
  return { stats, proxy, localTargets, config: { enabled: true, protocol: 'http', host: '127.0.0.1', port, username }, password }
}
async function requestJson(ses, url) {
  return new Promise((resolve, reject) => {
    const request = net.request({ session: ses, url, redirect: 'error', useSessionCookies: false })
    const timer = setTimeout(() => { request.abort(); reject(new Error('Synthetic request timed out')) }, 5000)
    request.on('error', error => { clearTimeout(timer); reject(error) })
    request.on('response', response => {
      let body = ''; response.on('data', chunk => { body += chunk }); response.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(body)) } catch (error) { reject(error) } })
      response.on('error', error => { clearTimeout(timer); reject(error) })
    }); request.end()
  })
}
app.whenReady().then(async () => {
  const originalRequest = net.request.bind(net)
  net.request = options => {
    const request = originalRequest(options)
    request.on('error', error => console.log('fixture request error', error.message))
    request.on('login', info => console.log('fixture proxy challenge', info.isProxy, info.host, info.port))
    request.on('close', () => console.log('fixture request closed'))
    request.on('response', response => {
      console.log('fixture response', response.statusCode)
      response.on('end', () => console.log('fixture response ended'))
      response.on('aborted', () => console.log('fixture response aborted'))
    })
    return request
  }
  const { checkGoogleVoiceSession, attachGoogleVoiceProxyAuth } = require(join(output, 'network.cjs'))
  const { configureProxySession } = require(join(output, 'accountProxy.cjs'))
  const a = await makeProxy('203.0.113.21', 'synthetic-a', 'synthetic-password-a'), b = await makeProxy('203.0.113.22', 'synthetic-b', 'synthetic-password-b')
  const sesA = isolated('a'), sesB = isolated('b')
  await Promise.all([configureProxySession(sesA, a.config), configureProxySession(sesB, b.config)])
  await sesA.cookies.set({ url: 'https://api.ipify.org', name: 'synthetic-only', value: 'never-send-this-cookie', secure: true })
  const [ipA, ipB] = await Promise.all([checkGoogleVoiceSession(sesA, a.config, a.password), checkGoogleVoiceSession(sesB, b.config, b.password)])
  assert.equal(ipA.ip, '203.0.113.21'); assert.equal(ipB.ip, '203.0.113.22')
  assert.ok(a.stats.accepted > 0 && b.stats.accepted > 0)
  checks.push('Actual Electron checkGoogleVoiceSession follows each supplied Session through a distinct localhost CONNECT proxy')
  assert.equal(a.stats.cookieHeaders + b.stats.cookieHeaders, 0); assert.equal(a.stats.originAuthHeaders + b.stats.originAuthHeaders, 0)
  checks.push('Actual HTTPS IP checks omit cookies and never forward proxy credentials as origin Authorization')
  const wrong = isolated('wrong'), beforeSupplied = a.stats.supplied, beforeRequests = a.stats.requests
  await configureProxySession(wrong, a.config)
  await assert.rejects(checkGoogleVoiceSession(wrong, a.config, 'synthetic-wrong-password'), /认证失败|连接检测失败/)
  assert.equal(a.stats.supplied - beforeSupplied, 1); assert.equal(a.stats.requests, beforeRequests)
  checks.push('Actual 407 rejection supplies the wrong synthetic credentials once and never reaches the origin')
  const untrusted = isolated('untrusted-tls', false); await configureProxySession(untrusted, b.config)
  await assert.rejects(checkGoogleVoiceSession(untrusted, b.config, b.password), /连接检测失败/)
  checks.push('A session without fixture trust rejects the self-signed TLS certificate; product TLS verification remains enabled')
  const browserSession = isolated('webcontents'), seen = []
  await configureProxySession(browserSession, a.config)
  const win = new BrowserWindow({ show: false, webPreferences: { session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false } }); windows.push(win)
  const initialLoginListeners = win.webContents.listenerCount('login')
  const detach = attachGoogleVoiceProxyAuth(win.webContents, a.config, a.password)
  win.webContents.on('login', (_event, details, info) => seen.push({ first: details.firstAuthAttempt, isProxy: info.isProxy, port: info.port }))
  await win.loadURL('https://api.ipify.org?format=json')
  assert.ok(seen.some(info => info.first === true && info.isProxy === true && info.port === a.config.port))
  checks.push('Actual WebContents login uses details/authInfo arguments and successfully authenticates only its own proxy')
  detach(); assert.equal(win.webContents.listenerCount('login'), initialLoginListeners + 1); win.destroy()
  const wrongBrowserSession = isolated('wrong-webcontents'); await configureProxySession(wrongBrowserSession, b.config)
  const wrongWin = new BrowserWindow({ show: false, webPreferences: { session: wrongBrowserSession, sandbox: true, contextIsolation: true, nodeIntegration: false } }); windows.push(wrongWin)
  const failureInfo = [], badCount = b.stats.supplied
  attachGoogleVoiceProxyAuth(wrongWin.webContents, b.config, 'synthetic-wrong-password')
  wrongWin.webContents.on('login', (_event, details) => failureInfo.push(details.firstAuthAttempt))
  await assert.rejects(wrongWin.loadURL('https://api.ipify.org?format=json'))
  assert.deepEqual(failureInfo, [true, false]); assert.equal(b.stats.supplied - badCount, 1)
  const badContents = wrongWin.webContents, beforeCloseListeners = badContents.listenerCount('login')
  const destroyed = new Promise(resolve => badContents.once('destroyed', resolve))
  wrongWin.destroy(); await destroyed; assert.ok(badContents.listenerCount('login') < beforeCloseListeners)
  checks.push('Actual WebContents authentication failure is not retried with the same credentials and its handler is removed on close')
  let directRequests = 0
  const direct = track(https.createServer(identity, (_request, response) => { directRequests++; response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ip":"203.0.113.99"}') }))
  const directPort = await listen(direct), directUrl = 'https://127.0.0.1:' + directPort + '/fixture'
  const directSession = isolated('direct-control'); await directSession.setProxy({ mode: 'direct' })
  assert.equal((await requestJson(directSession, directUrl)).ip, '203.0.113.99'); assert.equal(directRequests, 1)
  a.localTargets.add('127.0.0.1:' + directPort)
  await sesA.closeAllConnections()
  for (const socket of [...sockets]) socket.destroy()
  await new Promise(resolve => a.proxy.close(resolve))
  const beforeDirect = directRequests
  await assert.rejects(requestJson(sesA, directUrl))
  assert.equal(directRequests, beforeDirect)
  checks.push('After the configured proxy stops, Chromium fails closed and does not hit a separately proven reachable direct origin')
  writeFileSync(join(output, 'results.json'), JSON.stringify({ runId: process.argv[3], passed: checks.length, checks, syntheticOnly: true, localOnly: true, realElectronNetwork: true, productionNetworkModuleUnmodified: true }, null, 2))
  console.log(JSON.stringify({ passed: checks.length, checks }))
  for (const socket of sockets) socket.destroy(); for (const server of servers) server.close(); app.exit(0)
}).catch(error => { for (const win of windows) if (!win.isDestroyed()) win.destroy(); for (const socket of sockets) socket.destroy(); for (const server of servers) server.close(); console.error(error.stack); app.exit(1) })
