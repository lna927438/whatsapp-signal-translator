import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {dirname,basename} from 'node:path'
import {fileURLToPath} from 'node:url'
import {parse,compileScript,compileStyle} from '@vue/compiler-sfc'
export async function voiceMediaBundle(){
 const require=createRequire(new URL('../package.json',import.meta.url)),{build}=createRequire(require.resolve('vite'))('esbuild'),directory=fileURLToPath(new URL('../src/renderer/src/components/',import.meta.url))
 const result=await build({stdin:{resolveDir:directory,sourcefile:'voice-component-fixture.ts',contents:`
  import {createApp,h,reactive} from 'vue';import SignalMedia from './SignalMedia.vue';
  const props=reactive({accountId:'fixture-signal',peer:'+12025550123',attachment:{id:'attachment',contentType:'audio/ogg',size:123,isVoiceNote:true},timestamp:100});
  const app=createApp({render:()=>h(SignalMedia,props)});app.mount('#app');window.__setProps=value=>Object.assign(props,value);window.__dispose=()=>app.unmount();
 `},bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',define:{'process.env.NODE_ENV':'"production"','__VUE_OPTIONS_API__':'true','__VUE_PROD_DEVTOOLS__':'false','__VUE_PROD_HYDRATION_MISMATCH_DETAILS__':'false'},plugins:[{name:'voice-synthetic-transport',setup(build:any){
  build.onResolve({filter:/^\.\.\/lib\/uiLocale$/},()=>({path:'locale',namespace:'voice-fixture'}))
  build.onLoad({filter:/.*/,namespace:'voice-fixture'},()=>({loader:'js',contents:'export const t=value=>value,uiError=value=>value;'}))
  build.onResolve({filter:/SignalMediaViewer\.vue$/},()=>({path:'viewer',namespace:'unrelated-viewer'}))
  build.onLoad({filter:/.*/,namespace:'unrelated-viewer'},()=>({loader:'js',contents:'export default {render:()=>null}'}))
  build.onLoad({filter:/\.vue$/},async(args:any)=>{
   const {descriptor}=parse(await readFile(args.path,'utf8'),{filename:args.path}),id='data-v-voice-'+basename(args.path).replace(/\W/g,''),script=compileScript(descriptor,{id,inlineTemplate:true}).content.replace('export default','const __component=')
   const css=descriptor.styles.map(style=>compileStyle({source:style.content,filename:args.path,id,scoped:style.scoped}).code).join('\n')
   return{loader:'ts',resolveDir:dirname(args.path),contents:script+`\n__component.__scopeId=${JSON.stringify(id)};export default __component;const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.appendChild(style);`}
  })
 }}]});return result.outputFiles[0].text
}
