import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {parse,compileScript,compileStyle} from '@vue/compiler-sfc'

export async function desktopAuthBundle(mode: 'auth' | 'root' = 'auth'):Promise<string>{
 const websiteRequire=createRequire(new URL('../website/package.json',import.meta.url)),runtimeRequire=createRequire(websiteRequire.resolve('wrangler'))
 const {build}=runtimeRequire('esbuild'),directory=fileURLToPath(new URL('../src/renderer/src/components/',import.meta.url))
 const rootEntry = `import {createApp} from 'vue';import Root from '../Root.vue';const app=createApp(Root);app.mount('#app');window.__dispose=()=>app.unmount();`
 const authEntry = `
 import {createApp,h,reactive} from 'vue';import AuthView from './AuthView.vue';import {uiLanguage} from '../lib/uiLocale';
 window.__setLanguage=value=>uiLanguage.value=value;
 const props=reactive(window.__props||{});const app=createApp({render:()=>h(AuthView,{...props,onAuthenticated:s=>window.__authenticated.push(s),onCancelled:()=>window.__cancelled++})});
 app.mount('#app');window.__setProps=p=>Object.assign(props,p);window.__dispose=()=>app.unmount();
 `
 const result=await build({stdin:{sourcefile:'desktop-auth-fixture.ts',resolveDir:directory,contents:mode==='root'?rootEntry:authEntry},bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',define:{'process.env.NODE_ENV':'"production"','import.meta.env.VITE_AUTH_CAPTCHA_ENABLED':'"false"','__VUE_OPTIONS_API__':'true','__VUE_PROD_DEVTOOLS__':'false','__VUE_PROD_HYDRATION_MISMATCH_DETAILS__':'false'},plugins:[{name:'auth-fixture',setup(build:any){
 build.onResolve({filter:/^\.\.?\/lib\/supabase$/},()=>({path:'supabase',namespace:'fixture'}))
 build.onResolve({filter:/^\.\/UiLanguagePicker\.vue$/},()=>({path:'picker',namespace:'fixture'}))
 build.onResolve({filter:/^\.\/App\.vue$/},()=>({path:'workspace',namespace:'fixture'}))
 build.onLoad({filter:/.*/,namespace:'fixture'},(args:any)=>({loader:'ts',resolveDir:directory,contents:args.path==='workspace'?`
 import {h,ref,onUnmounted} from 'vue';export default {props:['userId'],setup(props){const draft=ref('');window.__mounts++;onUnmounted(()=>window.__unmounts++);return()=>h('section',{class:'fixture-workspace'},[h('span',{class:'fixture-owner'},props.userId),h('input',{class:'fixture-draft',value:draft.value,onInput:e=>draft.value=e.target.value})])}}
 `:args.path==='picker'?'export default {render:()=>null}':`
 export const supabaseConfigured=true;
 export const signingOut=false;
 export const authStorage={setRemember:value=>window.__remember=value};
 export const requireSupabase=()=>window.__client;
 export const createTransientSupabase=()=>window.__recoveryClient||window.__client;
 `}))
 build.onLoad({filter:/\.vue$/},async(args:any)=>{
 const {descriptor}=parse(await readFile(args.path,'utf8'),{filename:args.path})
 const id='data-v-auth-mfa-fixture',script=compileScript(descriptor,{id,inlineTemplate:true}).content.replace('export default','const __component=')
 const css=descriptor.styles.map(style=>compileStyle({source:style.content,filename:args.path,id,scoped:style.scoped}).code).join('\n')
 return{loader:'ts',resolveDir:dirname(args.path),contents:script+`\n__component.__scopeId=${JSON.stringify(id)};export default __component;const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.appendChild(style);`}
 })
 }}]})
 return result.outputFiles[0].text
}
