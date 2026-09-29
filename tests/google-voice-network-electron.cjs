const { app, BrowserWindow, net, session } = require('electron')
const assert = require('node:assert/strict')
const http = require('node:http'), https = require('node:https'), tcp = require('node:net')
const { readFileSync, writeFileSync, mkdtempSync } = require('node:fs')
const { join } = require('node:path'), { randomUUID, X509Certificate } = require('node:crypto')
const { makeSocksFixture } = require('./google-voice-socks-fixture.cjs')
const output = process.argv[2], checks = [], servers = [], windows = [], sockets = new Set()
const socksPeers = [], socksRoutes = []
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
    try { matching = ['api.ipify.org', 'voice.google.com', 'accounts.google.com', '127.0.0.1'].includes(details.hostname) && new X509Certificate(details.certificate.data).fingerprint256 === fingerprint } catch {}
    callback(matching ? 0 : -3)
  })
}
function isolated(label, trust = true) {
  const ses = session.fromPartition('voice-network-fixture-' + label + '-' + randomUUID(), { cache: false })
  if (trust) trustFixture(ses)
  // Exclude Chromium component-update traffic from per-request auth counters.
  ses.webRequest.onBeforeRequest((details, callback) => { let allowed = false; try { allowed = ['api.ipify.org', 'voice.google.com', 'accounts.google.com', '127.0.0.1'].includes(new URL(details.url).hostname) } catch {} callback({ cancel: !allowed }) })
  return ses
}
async function makeProxy(ip, username, password) {
  const stats = { challenges: 0, supplied: 0, accepted: 0, requests: 0, cookieHeaders: 0, originAuthHeaders: 0, foreignTargets: 0, signInRootRequests: 0, legacySignInRequests: 0, followedSignInRedirects: 0 }
  const backend = track(https.createServer(identity, (request, response) => {
    stats.requests++; if (request.headers.cookie) stats.cookieHeaders++; if (request.headers.authorization) stats.originAuthHeaders++
    if (request.headers.host === 'accounts.google.com') {
      // Reproduce the real cookie-free Electron distinction: the transaction
      // endpoint refuses the probe, while the public entry redirects normally.
      const target = new URL(request.url, 'https://accounts.google.com')
      if (target.pathname === '/') {
        stats.signInRootRequests++
        response.writeHead(302, { location: 'https://accounts.google.com/ServiceLogin?fixture=must-not-follow', 'cache-control': 'no-store', 'set-cookie': 'synthetic-google=must-not-overwrite; Secure; HttpOnly; Path=/', connection: 'close' }); response.end(); return
      }
      if (target.pathname === '/ServiceLogin') {
        stats.legacySignInRequests++
        if (target.search) stats.followedSignInRedirects++
        response.writeHead(401, { 'content-type': 'text/plain', 'cache-control': 'no-store', connection: 'close' }); response.end('Synthetic transaction endpoint requires browser state'); return
      }
    }
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'set-cookie': 'synthetic-only=must-not-overwrite; Secure; HttpOnly; Path=/', connection: 'close' }); response.end(JSON.stringify({ ip }))
  }))
  const backendPort = await listen(backend)
  const proxy = track(http.createServer((_request, response) => { response.writeHead(400, { connection: 'close' }); response.end() }))
  const expected = 'Basic ' + Buffer.from(username + ':' + password).toString('base64')
  const localTargets = new Set(['api.ipify.org:443', 'voice.google.com:443', 'accounts.google.com:443'])
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
async function legacySignInStatus(ses, fixture) {
  return new Promise((resolve, reject) => {
    const request = net.request({ session: ses, url: 'https://accounts.google.com/ServiceLogin', method: 'GET', redirect: 'error', useSessionCookies: false })
    const timer = setTimeout(() => { request.abort(); reject(new Error('Synthetic legacy sign-in request timed out')) }, 5000)
    let supplied = false
    request.on('login', (info, callback) => {
      if (!supplied && info.isProxy && info.host === fixture.config.host && info.port === fixture.config.port) { supplied = true; callback(fixture.config.username, fixture.password) }
      else callback()
    })
    request.on('error', error => { clearTimeout(timer); reject(error) })
    request.on('response', response => {
      response.on('data', () => {})
      response.on('end', () => { clearTimeout(timer); resolve(response.statusCode) })
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
  const { checkGoogleVoiceSession, attachGoogleVoiceProxyAuth, prepareGoogleVoiceNetwork, testGoogleVoiceProxy } = require(join(output, 'network.cjs'))
  const { configureProxySession } = require(join(output, 'accountProxy.cjs'))
  const a = await makeProxy('203.0.113.21', 'synthetic-a', 'synthetic-password-a'), b = await makeProxy('203.0.113.22', 'synthetic-b', 'synthetic-password-b')
  const sesA = isolated('a'), sesB = isolated('b')
  await Promise.all([configureProxySession(sesA, a.config), configureProxySession(sesB, b.config)])
  await sesA.cookies.set({ url: 'https://api.ipify.org', name: 'synthetic-only', value: 'never-send-this-cookie', secure: true })
  await sesA.cookies.set({ url: 'https://accounts.google.com', name: 'synthetic-google', value: 'never-send-google-cookie', secure: true })
  assert.equal(await legacySignInStatus(sesA, a), 401)
  assert.equal(a.stats.legacySignInRequests, 1)
  const [ipA, ipB] = await Promise.all([checkGoogleVoiceSession(sesA, a.config, a.password), checkGoogleVoiceSession(sesB, b.config, b.password)])
  assert.equal(ipA.ip, '203.0.113.21'); assert.equal(ipB.ip, '203.0.113.22')
  assert.ok(a.stats.accepted > 0 && b.stats.accepted > 0)
  assert.equal(ipA.reachable, true); assert.equal(ipB.reachable, true)
  assert.ok(Object.values(ipA.checks).every(value => value.status === 'reachable'))
  assert.equal(ipA.checks.signIn.httpStatus, 302); assert.equal(ipB.checks.signIn.httpStatus, 302)
  assert.equal(a.stats.signInRootRequests, 1); assert.equal(b.stats.signInRootRequests, 1)
  assert.equal(a.stats.legacySignInRequests, 1); assert.equal(b.stats.legacySignInRequests, 0)
  assert.equal(a.stats.followedSignInRedirects + b.stats.followedSignInRedirects, 0)
  checks.push('Actual Electron diagnostics use each isolated CONNECT proxy and accept the cookie-free official 302 entry without following it, even when legacy ServiceLogin returns 401')
  assert.equal(a.stats.cookieHeaders + b.stats.cookieHeaders, 0); assert.equal(a.stats.originAuthHeaders + b.stats.originAuthHeaders, 0)
  const storedCookies = await sesA.cookies.get({ url: 'https://api.ipify.org' })
  assert.equal(storedCookies.find(value => value.name === 'synthetic-only')?.value, 'never-send-this-cookie')
  const storedGoogleCookies = await sesA.cookies.get({ url: 'https://accounts.google.com' })
  assert.equal(storedGoogleCookies.length, 1); assert.equal(storedGoogleCookies[0].name, 'synthetic-google'); assert.equal(storedGoogleCookies[0].value, 'never-send-google-cookie')
  assert.deepEqual(await sesB.cookies.get({ url: 'https://accounts.google.com' }), [])
  checks.push('Actual three-endpoint HTTPS checks omit cookies, do not store Set-Cookie, preserve existing cookies and never forward proxy credentials as origin Authorization')
  const wrong = isolated('wrong'), beforeSupplied = a.stats.supplied, beforeRequests = a.stats.requests
  await configureProxySession(wrong, a.config)
  const wrongResult = await checkGoogleVoiceSession(wrong, a.config, 'synthetic-wrong-password')
  assert.ok(Object.values(wrongResult.checks).every(value => value.code === 'proxy-auth'))
  assert.equal(a.stats.supplied - beforeSupplied, 3); assert.equal(a.stats.requests, beforeRequests)
  checks.push('Actual 407 rejection supplies wrong credentials at most once per fixed endpoint and never reaches the origin')
  const untrusted = isolated('untrusted-tls', false); await configureProxySession(untrusted, b.config)
  assert.equal((await checkGoogleVoiceSession(untrusted, b.config, b.password)).reachable, false)
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
  const stoppedProxy = await checkGoogleVoiceSession(sesA, a.config, a.password)
  assert.equal(stoppedProxy.reachable, false)
  assert.ok(Object.values(stoppedProxy.checks).every(value => value.status === 'failed' && value.code === 'proxy-connect'))
  assert.equal(directRequests, beforeDirect)
  checks.push('After the configured proxy stops, all three production diagnostic probes fail closed and Chromium never reaches the proven direct origin')
  const socksExit = async ip => {
    const server = track(https.createServer(identity, (_request, response) => { response.writeHead(200, { 'content-type': 'application/json', connection: 'close' }); response.end(JSON.stringify({ ip })) }))
    return listen(server)
  }
  const peerA = await makeSocksFixture(await socksExit('203.0.113.31'), 'socks-user-a', 'socks-pass-a', { fragmented: true })
  const peerB = await makeSocksFixture(await socksExit('203.0.113.32'), 'socks-user-b', 'socks-pass-b')
  socksPeers.push(peerA, peerB)
  const socksA = { enabled: true, protocol: 'socks5', host: '127.0.0.1', port: peerA.port, username: 'socks-user-a', hasPassword: true }
  const socksB = { enabled: true, protocol: 'socks5', host: '127.0.0.1', port: peerB.port, username: 'socks-user-b', hasPassword: true }
  const routeA = await prepareGoogleVoiceNetwork(socksA, 'socks-pass-a'), routeB = await prepareGoogleVoiceNetwork(socksB, 'socks-pass-b'); socksRoutes.push(routeA, routeB)
  const socksSessionA = isolated('socks-a'), socksSessionB = isolated('socks-b')
  await Promise.all([configureProxySession(socksSessionA, routeA.proxy), configureProxySession(socksSessionB, routeB.proxy)])
  const socksIPs = await Promise.all([checkGoogleVoiceSession(socksSessionA, routeA.proxy, routeA.password, { route: routeA }), checkGoogleVoiceSession(socksSessionB, routeB.proxy, routeB.password, { route: routeB })])
  assert.deepEqual(socksIPs.map(value => value.ip), ['203.0.113.31', '203.0.113.32'])
  for (const host of ['api.ipify.org', 'voice.google.com', 'accounts.google.com']) assert.ok(peerA.stats.targets.some(value => value.type === 3 && value.host === host))
  assert.ok(socksIPs.every(value => value.reachable))
  assert.notEqual(routeA.proxy.port, routeB.proxy.port); assert.notEqual(routeA.password, routeB.password)
  checks.push('Two actual Electron Sessions tunnel HTTPS through independently authenticated SOCKS5 peers with remote target DNS')
  const badSocksRoute = await prepareGoogleVoiceNetwork(socksA, 'socks-wrong-password'); socksRoutes.push(badSocksRoute)
  const badSocksSession = isolated('socks-wrong'), beforeBad = peerA.stats.authAttempts
  await configureProxySession(badSocksSession, badSocksRoute.proxy)
  const badSocks = await checkGoogleVoiceSession(badSocksSession, badSocksRoute.proxy, badSocksRoute.password, { route: badSocksRoute })
  assert.ok(Object.values(badSocks.checks).every(value => value.code === 'proxy-auth'))
  assert.equal(peerA.stats.authAttempts - beforeBad, 3)
  await socksSessionA.closeAllConnections(); await socksSessionA.clearAuthCache()
  const beforeCross = peerA.stats.authAttempts
  assert.equal((await checkGoogleVoiceSession(socksSessionA, routeB.proxy, routeB.password)).reachable, false)
  assert.equal(peerA.stats.authAttempts, beforeCross)
  checks.push('Actual SOCKS wrong-password requests fail once per fixed endpoint and another window local capability cannot reach the peer')
  // Trust only our generated certificate in the isolated fixture process. The
  // production test function still creates/configures/closes its own session.
  app.on('session-created', trustFixture)
  try { assert.equal((await testGoogleVoiceProxy(socksB, 'socks-pass-b')).ip, '203.0.113.32') }
  finally { app.off('session-created', trustFixture) }
  checks.push('The actual settings-test function prepares, authenticates and closes a SOCKS5 route successfully')
  const socksWindowSession = isolated('socks-window'); await configureProxySession(socksWindowSession, routeB.proxy)
  const socksWindow = new BrowserWindow({ show: false, webPreferences: { session: socksWindowSession, sandbox: true, contextIsolation: true, nodeIntegration: false } }); windows.push(socksWindow)
  attachGoogleVoiceProxyAuth(socksWindow.webContents, routeB.proxy, routeB.password)
  await socksWindow.loadURL('https://api.ipify.org?format=json')
  assert.ok((await socksWindow.webContents.executeJavaScript('document.body.innerText')).includes('203.0.113.32'))
  socksWindow.destroy(); checks.push('An actual sandboxed WebContents opens HTTPS through the authenticated SOCKS5 bridge')
  await peerA.close(); await socksSessionA.closeAllConnections()
  const beforeSocksDirect = directRequests
  await assert.rejects(requestJson(socksSessionA, directUrl)); assert.equal(directRequests, beforeSocksDirect)
  const localA = routeA.proxy.port; await routeA.close(); await routeA.close()
  assert.equal(routeA.password, '')
  await assert.rejects(new Promise((resolve, reject) => { const connection = tcp.connect(localA, '127.0.0.1'); connection.once('connect', () => { connection.destroy(); resolve() }); connection.once('error', reject) }))
  checks.push('Stopping the SOCKS5 peer never falls back to direct access and closing its local route removes the listener')
  const { GoogleVoiceEmbeddedViews } = require(join(output, 'embeddedViews.cjs'))
  const host = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } }); windows.push(host)
  const states = [], pages = [], manager = new GoogleVoiceEmbeddedViews(host, { authorizeOwner: () => true, onState: state => states.push(state), onPage: page => pages.push(page.webContents) })
  manager.setBounds({ x: 0, y: 0, width: 900, height: 700 })
  app.on('session-created', trustFixture)
  const managedId = 'gv-70000000-0000-4000-8000-000000000007'
  try { manager.create('synthetic-network-owner', managedId, { proxy: socksB, password: 'socks-pass-b' }) }
  finally { app.off('session-created', trustFixture) }
  const deadline = Date.now() + 15000
  while (!states.some(state => state.status === 'ready')) { if (Date.now() > deadline) throw new Error('Managed SOCKS view did not finish loading'); await new Promise(resolve => setTimeout(resolve, 30)) }
  const managedPage = pages[0]
  await managedPage.loadURL('https://voice.google.com/u/0/messages?itemId=synthetic-only')
  const reloaded = new Promise(resolve => managedPage.once('did-finish-load', resolve))
  manager.reload('synthetic-network-owner', managedId); await reloaded
  assert.equal(pages[0], managedPage)
  assert.equal(managedPage.getURL(), 'https://voice.google.com/u/0/messages?itemId=synthetic-only')
  checks.push('Actual healthy refresh preserves the same view, session and selected conversation URL')
  const actualState = await manager.checkNetwork('synthetic-network-owner', managedId)
  assert.equal(actualState.status, 'checked'); assert.equal(actualState.ip, '203.0.113.32')
  assert.equal(pages[0].getURL(), 'https://voice.google.com/u/0/messages?itemId=synthetic-only')
  const actualRoute = await pages[0].session.resolveProxy('https://voice.google.com/u/0/'), managedPort = Number(/127\.0\.0\.1:(\d+)/.exec(actualRoute)?.[1])
  assert.ok(managedPort > 0)
  manager.close('synthetic-network-owner', managedId); manager.destroy(); host.destroy()
  await assert.rejects(new Promise((resolve, reject) => { const connection = tcp.connect(managedPort, '127.0.0.1'); connection.once('connect', () => { connection.destroy(); resolve() }); connection.once('error', reject) }))
  checks.push('Actual embedded manager creation configures the authenticated SOCKS route before Voice load, reports its IP and removes the bridge on close')
  writeFileSync(join(output, 'results.json'), JSON.stringify({ runId: process.argv[3], passed: checks.length, checks, syntheticOnly: true, localOnly: true, realElectronNetwork: true, productionNetworkModuleUnmodified: true }, null, 2))
  console.log(JSON.stringify({ passed: checks.length, checks }))
  await Promise.all(socksRoutes.map(route => route.close())); await Promise.all(socksPeers.map(peer => peer.close()))
  for (const socket of sockets) socket.destroy(); for (const server of servers) server.close(); app.exit(0)
}).catch(async error => { for (const win of windows) if (!win.isDestroyed()) win.destroy(); await Promise.allSettled(socksRoutes.map(route => route.close())); await Promise.allSettled(socksPeers.map(peer => peer.close())); for (const socket of sockets) socket.destroy(); for (const server of servers) server.close(); console.error(error.stack); app.exit(1) })
