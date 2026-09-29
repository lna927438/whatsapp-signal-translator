import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build, resolveConfig } from 'vite'
import { loadConfigFromFile, type RendererViteConfig } from 'electron-vite'

const require = createRequire(import.meta.url)
const { validatePublicAuthConfig } = require('../scripts/public-auth-config.ts') as typeof import('../scripts/public-auth-config')
const urlName = 'VITE_SUPABASE_URL'
const keyName = 'VITE_SUPABASE_PUBLISHABLE_KEY'
const projectUrl = 'https://abcdefghijklmnopqrst.supabase.co'
// Synthetic values only; these tests never contact Supabase.
const publicKey = 'sb_publishable_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const valid = { [urlName]: projectUrl, [keyName]: publicKey }
const legacyKey = (role: string, extra: Record<string, unknown> = {}) => [
  { alg: 'HS256', typ: 'JWT' }, { iss: 'supabase', role, ...extra },
].map(part => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.') + '.' + 'a'.repeat(43)

for (const [label, env] of [
  ['missing both values', {}],
  ['missing URL', { [keyName]: publicKey }],
  ['missing key', { [urlName]: projectUrl }],
  ['whitespace key', { ...valid, [keyName]: '  \n' }],
  ['placeholder URL', { ...valid, [urlName]: 'https://your-project.supabase.co' }],
  ['malformed URL', { ...valid, [urlName]: 'not-a-url' }],
  ['HTTP URL', { ...valid, [urlName]: projectUrl.replace('https:', 'http:') }],
  ['URL credentials', { ...valid, [urlName]: 'https://user:password@abcdefghijklmnopqrst.supabase.co' }],
  ['URL query', { ...valid, [urlName]: projectUrl + '?apikey=not-public' }],
  ['URL path', { ...valid, [urlName]: projectUrl + '/auth/v1' }],
  ['local URL', { ...valid, [urlName]: 'https://localhost:54321' }],
  ['placeholder key', { ...valid, [keyName]: 'sb_publishable_your_publishable_key' }],
  ['truncated key', { ...valid, [keyName]: 'sb_publishable_abc' }],
  ['unknown key', { ...valid, [keyName]: 'not-a-supabase-key' }],
  ['secret key', { ...valid, [keyName]: 'sb_secret_' + 'secret-value-must-not-be-logged' }],
  ['legacy service role', { ...valid, [keyName]: legacyKey('service_role') }],
  ['user session role', { ...valid, [keyName]: legacyKey('authenticated') }],
  ['wrong issuer', { ...valid, [keyName]: legacyKey('anon', { iss: 'untrusted' }) }],
  ['broken JWT payload', { ...valid, [keyName]: 'eyJhbGciOiJIUzI1NiJ9.invalid.signature' }],
] as const) {
  test(`public auth rejects ${label} without disclosing the supplied values`, () => {
    assert.throws(() => validatePublicAuthConfig(env), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /\[HelloDog public auth\] VITE_SUPABASE_/)
      for (const value of Object.values(env)) {
        if (value && value.trim().length > 4) assert.ok(!error.message.includes(value))
      }
      return true
    })
  })
}

test('public auth accepts publishable keys and legacy anon keys', () => {
  assert.doesNotThrow(() => validatePublicAuthConfig(valid))
  assert.doesNotThrow(() => validatePublicAuthConfig({ ...valid, [keyName]: legacyKey('anon') }))
  assert.doesNotThrow(() => validatePublicAuthConfig({ [urlName]: ` ${projectUrl}/ `, [keyName]: ` ${publicKey} ` }))
})

let renderer: RendererViteConfig
let fixtureRoot: string
const savedEnvironment = new Map<string, string | undefined>()
before(async () => {
  for (const name of [urlName, keyName]) {
    savedEnvironment.set(name, process.env[name])
    delete process.env[name]
  }
  const tempRoot = process.platform === 'win32' ? 'D:/UserAppData/Temp' : tmpdir()
  await mkdir(tempRoot, { recursive: true })
  fixtureRoot = await mkdtemp(join(tempRoot, 'hellodog-public-auth-tests-'))
  const loaded = await loadConfigFromFile(
    { command: 'build', mode: 'production' },
    fileURLToPath(new URL('../electron.vite.config.ts', import.meta.url)),
  )
  assert.ok(loaded?.config.renderer)
  renderer = loaded.config.renderer
})
after(async () => {
  for (const [name, value] of savedEnvironment) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true })
})

async function fixture(files: Record<string, string> = {}) {
  const root = await mkdtemp(join(fixtureRoot, 'case-'))
  await writeFile(join(root, 'index.html'), '<html><head></head><body><script type="module" src="/main.js"></script></body></html>')
  await writeFile(join(root, 'main.js'), 'window.publicAuth = [import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY]')
  for (const [name, contents] of Object.entries(files)) await writeFile(join(root, name), contents)
  return {
    ...renderer, root, envDir: root, configFile: false as const, logLevel: 'silent' as const,
    build: { write: false, minify: false, rollupOptions: { input: join(root, 'index.html') } },
  }
}
const envFile = (url = projectUrl, key = publicKey) => `${urlName}=${url}\n${keyName}=${key}\n`
async function emittedCode(config: Awaited<ReturnType<typeof fixture>>, mode = 'production') {
  const result = await build({ ...config, mode })
  assert.ok(!Array.isArray(result) && 'output' in result)
  return result.output.filter(output => output.type === 'chunk').map(output => output.code).join('\n')
}

test('the real renderer build fails if staging omits the only local env file', async () => {
  const configured = await fixture({ '.env.local': envFile() })
  assert.ok((await emittedCode(configured)).includes(publicKey))
  await assert.rejects(emittedCode(await fixture()), /VITE_SUPABASE_URL is missing/)
})

test('the real renderer guard rejects invalid and privileged keys before bundling', async () => {
  for (const key of ['sb_publishable_your_publishable_key', 'sb_secret_private-synthetic-value', legacyKey('service_role'), legacyKey('authenticated')]) {
    await assert.rejects(emittedCode(await fixture({ '.env.production': envFile(projectUrl, key) })), /\[HelloDog public auth\] VITE_SUPABASE_PUBLISHABLE_KEY/)
  }
})

test('Vite mode files and CI variables keep their standard precedence in the emitted renderer', async () => {
  const productionKey = publicKey + '-production'
  const modeLocalKey = publicKey + '-mode-local'
  const config = await fixture({
    '.env': envFile(),
    '.env.local': envFile(projectUrl, 'sb_secret_invalid-local-value'),
    '.env.production': envFile(projectUrl, productionKey),
    '.env.production.local': envFile(projectUrl, modeLocalKey),
  })
  const modeCode = await emittedCode(config)
  assert.ok(modeCode.includes(modeLocalKey))
  assert.ok(!modeCode.includes(productionKey))
  const ciKey = publicKey + '-ci'
  process.env[keyName] = ciKey
  try {
    const ciCode = await emittedCode(config)
    assert.ok(ciCode.includes(ciKey))
    assert.ok(!ciCode.includes(modeLocalKey))
    process.env[keyName] = ''
    await assert.rejects(emittedCode(config), /VITE_SUPABASE_PUBLISHABLE_KEY is missing/)
  } finally { delete process.env[keyName] }
})

test('all build modes are guarded while the development server can start unconfigured', async () => {
  const config = await fixture()
  await assert.rejects(emittedCode(config, 'staging'), /VITE_SUPABASE_URL is missing/)
  await assert.doesNotReject(resolveConfig(config, 'serve', 'development'))
})
