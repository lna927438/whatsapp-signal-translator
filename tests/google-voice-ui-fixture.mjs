import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, compileScript, compileStyle } from '@vue/compiler-sfc'

export async function googleVoiceAppBundle(extraComponents = []) {
  const websiteRequire = createRequire(new URL('../website/package.json', import.meta.url))
  const { build } = createRequire(websiteRequire.resolve('wrangler'))('esbuild')
  const directory = fileURLToPath(new URL('../src/renderer/src/', import.meta.url))
  const realComponents = new Set(['App.vue', 'AccountNavigation.vue', 'UiIcon.vue', 'GoogleVoiceLauncher.vue', 'GoogleVoiceNavigation.vue', 'GoogleVoiceContent.vue', 'GoogleVoiceTranslationSetup.vue', 'GoogleVoiceWindowSetup.vue'])
  for (const component of extraComponents) realComponents.add(component)
  const result = await build({
    stdin: { sourcefile: 'voice-app-fixture.ts', resolveDir: directory, contents: `import {createApp} from 'vue';import App from './App.vue';import {uiLanguage} from './lib/uiLocale';window.__language=value=>uiLanguage.value=value;const app=createApp(App,{userId:'synthetic-voice-owner'});app.mount('#app');window.__dispose=()=>app.unmount();` },
    bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022',
    define: { 'process.env.NODE_ENV': '"production"', '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
    plugins: [{ name: 'isolated-voice-app', setup(build) {
      build.onResolve({ filter: /(?:^|\/)cloudApi$/ }, () => ({ path: 'cloudApi', namespace: 'synthetic-cloud' }))
      build.onLoad({ filter: /.*/, namespace: 'synthetic-cloud' }, () => ({ loader: 'js', contents: 'export const cloudApi={me:async()=>({wallet:{balance:window.__cloudBalance??100000,lifetime_debited:20,lifetime_credited:100020},profile:{username:"Synthetic user"},user:{email:"qa@example.invalid"}})};' }))
      build.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
        const name = basename(path)
        if (!realComponents.has(name)) {
          const contents = name === 'SignalView.vue' ? `import {h,ref,onMounted} from 'vue';export default {setup(){const draft=ref('');onMounted(()=>window.__signalMounts++);return()=>h('div',{class:'synthetic-signal'},[h('label',['Synthetic Signal draft',h('input',{'aria-label':'Synthetic Signal draft',value:draft.value,onInput:e=>draft.value=e.target.value})])])}}` : 'import {h} from "vue";export default {setup(){return()=>h("div")}}'
          return { loader: 'js', resolveDir: dirname(path), contents }
        }
        const { descriptor } = parse(await readFile(path, 'utf8'), { filename: path })
        const id = 'data-v-voice-' + name.replace(/\W/g, '')
        const script = compileScript(descriptor, { id, inlineTemplate: true }).content.replace('export default', 'const __component=')
        const css = descriptor.styles.map(style => compileStyle({ source: style.content, filename: path, id, scoped: style.scoped }).code).join('\n')
        return { loader: 'ts', resolveDir: dirname(path), contents: script + `\n__component.__scopeId=${JSON.stringify(id)};export default __component;const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.appendChild(style);` }
      })
    } }]
  })
  return result.outputFiles[0].text
}
