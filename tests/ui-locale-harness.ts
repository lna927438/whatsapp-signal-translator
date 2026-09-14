import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { parse, compileScript } from '@vue/compiler-sfc'
import ts from 'typescript'
const require = createRequire(import.meta.url)
export function createUiLocaleHarness() {
const vue = require('vue')
const exports: any = {}
runInNewContext(ts.transpileModule(readFileSync(new URL('../src/renderer/src/lib/uiLocale.ts', import.meta.url), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText, {
  exports, require: (name: string) => name === 'vue' ? vue : require('../src/shared/uiLocale.ts'),
  get window(){ return (globalThis as any).window }, get document(){ return (globalThis as any).document },
  get navigator(){ return (globalThis as any).window.navigator }, get localStorage(){ return (globalThis as any).localStorage },
  clearTimeout
})
const uiLocale = exports
function languagePicker() {
  const {descriptor}=parse(readFileSync(new URL('../src/renderer/src/components/UiLanguagePicker.vue',import.meta.url),'utf8'))
  const source=compileScript(descriptor,{id:'language-picker',inlineTemplate:true}).content
  const output: any={}
  runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:output,require:(name:string)=>name==='vue'?vue:uiLocale})
  return output
}
return { uiLocale, languagePicker }
}
