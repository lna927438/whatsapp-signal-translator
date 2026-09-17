import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, compileScript, compileStyle } from '@vue/compiler-sfc'

const require = createRequire(import.meta.url)
const { chromium } = require('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright')
const websiteRequire = createRequire(new URL('../website/package.json', import.meta.url))
const { build } = createRequire(websiteRequire.resolve('wrangler'))('esbuild')
const directory = fileURLToPath(new URL('../src/renderer/src/components/', import.meta.url))
const folder = new URL('../verification/google-voice-ui-20260918/', import.meta.url)
await mkdir(folder, { recursive: true })

const bundle = await build({
  stdin: { sourcefile: 'voice-launcher-fixture.ts', resolveDir: directory, contents: `
    import {createApp,h} from 'vue';
    import GoogleVoiceLauncher from './GoogleVoiceLauncher.vue';
    import {uiLanguage} from '../lib/uiLocale';
    window.__language=value=>uiLanguage.value=value;
    window.__errors=[];
    createApp({render:()=>h('main',{class:'app-shell compact-shell','data-theme':'charcoal',style:'display:flex;padding:32px'},[
      h(GoogleVoiceLauncher,{onError:message=>window.__errors.push(message)}),
      h('p','Synthetic Google Voice launcher. No real browser app or account is opened.')
    ])}).mount('#app');`
  },
  bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"', '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
  plugins: [{ name: 'google-voice-vue', setup(build) {
    build.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
      const { descriptor } = parse(await readFile(path, 'utf8'), { filename: path })
      const id = 'data-v-google-voice-test'
      const script = compileScript(descriptor, { id, inlineTemplate: true }).content.replace('export default', 'const __component=')
      const css = descriptor.styles.map(style => compileStyle({ source: style.content, filename: path, id, scoped: style.scoped }).code).join('\n')
      return { loader: 'ts', resolveDir: dirname(path), contents: script + `\n__component.__scopeId=${JSON.stringify(id)};export default __component;const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.appendChild(style);` }
    })
  } }]
})

const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 640 } })
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.route('**/*', route => route.abort())
  await page.setContent('<!doctype html><html><body><div id="app"></div></body></html>')
  const css = (await Promise.all(['style.css', 'hellodog.css', 'workspace.css', 'compactSidebar.css'].map(name => readFile(new URL('../src/renderer/src/' + name, import.meta.url), 'utf8')))).join('\n')
  await page.addStyleTag({ content: css })
  await page.evaluate(() => {
    window.__calls = 0
    window.desktopAPI = {
      openGoogleVoice: () => { window.__calls++; return new Promise((resolve, reject) => { window.__resolve = resolve; window.__reject = reject }) }
    }
  })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  const button = page.getByRole('button', { name: 'Google Voice · 官方独立窗口' })
  await button.click()
  assert.equal(await button.isDisabled(), true)
  assert.equal(await button.getAttribute('aria-busy'), 'true')
  await button.dispatchEvent('click')
  assert.equal(await page.evaluate(() => window.__calls), 1, 'pending open cannot launch duplicate windows')
  await page.evaluate(() => window.__reject(new Error('请安装 Chrome 或 Edge 后重试。')))
  await page.waitForFunction(() => !document.querySelector('button').disabled)
  assert.deepEqual(await page.evaluate(() => window.__errors), ['请安装 Chrome 或 Edge 后重试。'])
  await button.focus()
  await page.keyboard.press('Enter')
  assert.equal(await page.evaluate(() => window.__calls), 2, 'failure allows retry with keyboard')
  await page.evaluate(() => window.__resolve({ browser: 'edge' }))
  await page.waitForFunction(() => !document.querySelector('button').disabled)
  assert.equal(await button.getAttribute('aria-busy'), 'false')
  await page.evaluate(() => window.__language('en'))
  assert.equal(await page.getByRole('button', { name: 'Google Voice · Official separate window' }).count(), 1)
  assert.deepEqual(pageErrors, [])
  await page.screenshot({ path: fileURLToPath(new URL('launcher.png', folder)) })
  const result = { passed: true, at: new Date().toISOString(), syntheticOnly: true, realBrowser: 'Edge', checks: ['separate-window accessible label', 'single IPC while opening', 'pending disabled state', 'error delivered to App toast event', 'retry after failure', 'keyboard activation', 'Chinese and English labels'], noRealAccountOrWindowOpened: true }
  await writeFile(new URL('browser-results.json', folder), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
} finally {
  await browser.close()
}
