import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from 'vite'

// Exercise the shipped Root/AuthView/Supabase bundle, with no source rebuild or
// replacement auth client. Prefer a renderer extracted from the packaged ASAR.
// Usage: node tests/built-login-browser.mjs <renderer-directory> <evidence-directory>
const [rendererArgument, evidenceArgument] = process.argv.slice(2)
if (!rendererArgument || !evidenceArgument) {
  console.error('Usage: node tests/built-login-browser.mjs <renderer-directory> <evidence-directory>')
  process.exit(2)
}

const repository = fileURLToPath(new URL('..', import.meta.url))
const rendererDirectory = await realpath(path.resolve(rendererArgument))
const evidenceDirectory = path.resolve(evidenceArgument)
await mkdir(evidenceDirectory, { recursive: true })
const temporaryDirectory = path.join(evidenceDirectory, 'browser-temp')
await mkdir(temporaryDirectory, { recursive: true })
// Playwright's temporary browser profile must also respect the D-drive policy.
process.env.TEMP = temporaryDirectory
process.env.TMP = temporaryDirectory
process.env.TMPDIR = temporaryDirectory

const { chromium } = createRequire(import.meta.url)(
  'D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright'
)
const localOrigin = 'https://built-login.example.invalid'
const syntheticEmail = 'built-login-regression@example.invalid'
const syntheticPassword = `Synthetic-only-${randomUUID()}`
const missingConfiguration = /在线账号配置尚未注入|在线账号尚未配置|在线登录尚未配置|当前安装包缺少登录服务配置|Sign-in is (?:unavailable in this build|not configured)|This build is missing its sign-in configuration/i
const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff': 'font/woff', '.woff2': 'font/woff2'
}
const report = {
  at: new Date().toISOString(), rendererDirectory, passed: false,
  realBuiltRenderer: true, sourceModulesMocked: false,
  browser: 'headless Edge, fresh context', syntheticAuthenticationOnly: true,
  realNetworkBlocked: true, syntheticResponse: { status: 400, code: 'invalid_credentials' },
  authRequests: [], servedAssets: [], blockedRequests: 0, missingAssets: 0,
  pageErrors: 0, bridge: null, missingConfigurationWarning: null,
  syntheticErrorVisible: false, failureReasons: [], screenshot: null
}
let browser
let page
let stage = 'expected-configuration'
const servedAssets = new Map()

try {
  // Load only the two allowed public build values. Never write them, the request
  // headers/body, console output, or raw Playwright errors to the evidence.
  const publicEnv = loadEnv('production', repository, [
    'VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY'
  ])
  const expectedUrl = String(publicEnv.VITE_SUPABASE_URL || '').trim()
  const expectedKey = String(publicEnv.VITE_SUPABASE_PUBLISHABLE_KEY || '').trim()
  if (!expectedUrl || !expectedKey) throw new Error('expected-configuration-missing')
  const expectedTokenUrl = new URL(`${expectedUrl.replace(/\/+$/, '')}/auth/v1/token`)
  if (!['https:', 'http:'].includes(expectedTokenUrl.protocol)) throw new Error('expected-url-invalid')

  stage = 'browser-launch'
  browser = await chromium.launch({
    channel: 'msedge', headless: true,
    // Routes below never continue a request. The dead proxy and DNS rule also
    // prevent browser background traffic from contacting real remote services.
    proxy: { server: 'http://127.0.0.1:9', bypass: '<-loopback>' },
    args: ['--host-resolver-rules=MAP * ~NOTFOUND', '--disable-background-networking', '--disable-component-update']
  })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 }, locale: 'zh-CN', serviceWorkers: 'block'
  })
  await context.routeWebSocket('**/*', socket => {
    report.blockedRequests += 1
    socket.close()
  })
  await context.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin === localOrigin) {
      try {
        const requestedPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
        const assetPath = await realpath(path.resolve(rendererDirectory, `.${requestedPath}`))
        const relativePath = path.relative(rendererDirectory, assetPath)
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) throw new Error('asset-outside-renderer')
        const body = await readFile(assetPath)
        servedAssets.set(relativePath.replaceAll('\\', '/'), createHash('sha256').update(body).digest('hex'))
        await route.fulfill({ status: 200, contentType: contentTypes[path.extname(assetPath)] || 'application/octet-stream', body })
      } catch {
        report.missingAssets += 1
        await route.abort('blockedbyclient')
      }
      return
    }

    const expectedEndpoint = url.origin === expectedTokenUrl.origin && url.pathname === expectedTokenUrl.pathname
    const corsHeaders = { 'access-control-allow-origin': localOrigin, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': '*' }
    if (expectedEndpoint && request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: corsHeaders, body: '' })
      return
    }
    if (url.pathname.endsWith('/auth/v1/token')) {
      let payload
      try { payload = request.postDataJSON() } catch { /* Report only boolean checks. */ }
      const check = {
        expectedEndpoint,
        passwordGrant: url.searchParams.get('grant_type') === 'password',
        postMethod: request.method() === 'POST',
        expectedPublicKey: request.headers().apikey === expectedKey,
        syntheticEmail: payload?.email === syntheticEmail,
        syntheticPassword: payload?.password === syntheticPassword
      }
      report.authRequests.push(check)
      if (Object.values(check).every(Boolean)) {
        await route.fulfill({
          status: 400, contentType: 'application/json', headers: corsHeaders,
          body: JSON.stringify({ code: 'invalid_credentials', message: 'Invalid login credentials' })
        })
        return
      }
    }
    report.blockedRequests += 1
    await route.abort('blockedbyclient')
  })
  await context.addInitScript(() => {
    const storage = new Map()
    const counters = { storageReads: 0, storageWrites: 0, nonNullOnlineSessions: 0 }
    window.__builtLoginBridge = counters
    window.desktopAPI = {
      authStorageGet: async key => { counters.storageReads += 1; return storage.get(key) ?? null },
      authStorageSet: async (key, value) => {
        counters.storageWrites += 1
        if (value === null) storage.delete(key)
        else storage.set(key, value)
      },
      authSetOnlineSession: async session => { if (session) counters.nonNullOnlineSessions += 1 },
      onAuthRefreshRequested: () => () => {},
      getUiLanguage: async () => 'zh-CN',
      setUiLanguage: async () => {},
      onUiLanguageChanged: () => () => {}
    }
  })
  page = await context.newPage()
  page.setDefaultTimeout(12000)
  page.on('pageerror', () => { report.pageErrors += 1 })
  stage = 'load-built-renderer'
  await page.goto(`${localOrigin}/index.html`, { waitUntil: 'load' })
  const email = page.locator('input[autocomplete="username"]')
  const password = page.locator('input[autocomplete="current-password"]')
  await email.waitFor({ state: 'visible' })
  stage = 'submit-built-login'
  await email.fill(syntheticEmail)
  await password.fill(syntheticPassword)
  await page.locator('.auth-submit').click()
  await page.locator('.auth-error').waitFor({ state: 'visible' })
  const visibleError = await page.locator('.auth-error').innerText()
  report.missingConfigurationWarning = missingConfiguration.test(visibleError)
  report.syntheticErrorVisible = visibleError.includes('Invalid login credentials')
  report.bridge = await page.evaluate(() => window.__builtLoginBridge)
  // Do not retain even a masked synthetic password in screenshot evidence.
  await password.fill('')
  report.screenshot = 'built-login.png'
  await page.screenshot({ path: path.join(evidenceDirectory, report.screenshot), fullPage: true })

  if (report.missingConfigurationWarning) report.failureReasons.push('built-renderer-missing-auth-configuration')
  if (report.authRequests.length !== 1) report.failureReasons.push('expected-exactly-one-auth-request')
  if (report.authRequests.some(check => !Object.values(check).every(Boolean))) report.failureReasons.push('auth-request-does-not-match-public-build-config-and-synthetic-input')
  if (!report.syntheticErrorVisible) report.failureReasons.push('synthetic-auth-error-not-displayed')
  if (report.pageErrors) report.failureReasons.push('renderer-page-errors')
  if (report.missingAssets) report.failureReasons.push('built-renderer-assets-missing')
  if (report.blockedRequests) report.failureReasons.push('unexpected-network-request-blocked')
  if (!report.bridge?.storageReads) report.failureReasons.push('real-auth-storage-not-initialized')
  if (report.bridge?.nonNullOnlineSessions) report.failureReasons.push('unexpected-authenticated-session')
  report.passed = report.failureReasons.length === 0
} catch {
  // Raw exception messages may contain source excerpts, keys, or request data.
  report.failureReasons.push(`could-not-complete-${stage}`)
} finally {
  await browser?.close()
  report.servedAssets = [...servedAssets].map(([file, sha256]) => ({ file, sha256 }))
  await writeFile(path.join(evidenceDirectory, 'results.json'), `${JSON.stringify(report, null, 2)}\n`)
}

console.log(JSON.stringify({
  passed: report.passed, authRequestCount: report.authRequests.length,
  missingConfigurationWarning: report.missingConfigurationWarning,
  failureReasons: report.failureReasons, evidenceDirectory
}))
if (!report.passed) process.exitCode = 1
