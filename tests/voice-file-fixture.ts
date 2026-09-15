import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {dirname,basename} from 'node:path'
import {fileURLToPath} from 'node:url'
import {parse,compileScript,compileStyle} from '@vue/compiler-sfc'

/** Compile the shipped Vue component. Only local decoding, IPC and localization
 * are replaced; fixtures never read a real voice file or invoke a provider. */
export async function voiceFileBundle():Promise<string>{
 const websiteRequire=createRequire(new URL('../website/package.json',import.meta.url)),{build}=createRequire(websiteRequire.resolve('wrangler'))('esbuild')
 const components=fileURLToPath(new URL('../src/renderer/src/components/',import.meta.url))
 const result=await build({stdin:{sourcefile:'voice-file-fixture.ts',resolveDir:components,contents:`
  import {createApp,h,reactive} from 'vue';import VoiceFileTool from './VoiceFileTool.vue';
  const props=reactive({accounts:[{id:'wa',platform:'whatsapp',label:'WhatsApp 工作账号'},{id:'signal',platform:'signal',label:'Signal 工作账号'}],selectedId:'wa',...window.__props});
  const app=createApp({render:()=>h(VoiceFileTool,props)});app.mount('#app');
  window.__setProps=value=>Object.assign(props,value);window.__dispose=()=>app.unmount();
 `},bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',define:{'process.env.NODE_ENV':'"production"','__VUE_OPTIONS_API__':'true','__VUE_PROD_DEVTOOLS__':'false','__VUE_PROD_HYDRATION_MISMATCH_DETAILS__':'false'},plugins:[{
  name:'real-voice-tool-synthetic-input',setup(build:any){
   build.onResolve({filter:/\/lib\/uiLocale$/},()=>({path:'locale',namespace:'voice-fixture'}))
   build.onResolve({filter:/\/shared\/voiceAudio$/},()=>({path:'decode',namespace:'voice-fixture'}))
   build.onLoad({filter:/.*/,namespace:'voice-fixture'},(args:any)=>({loader:'js',contents:args.path==='locale'?'export const t=value=>value,uiError=value=>value;':'export const voiceAudioWav=url=>window.__decode(url);'}))
   build.onLoad({filter:/\.vue$/},async(args:any)=>{
    const source=await readFile(args.path,'utf8'),{descriptor}=parse(source,{filename:args.path}),id='data-v-voice-test-'+basename(args.path).replace(/\W/g,'')
    const script=compileScript(descriptor,{id,inlineTemplate:true}).content.replace('export default','const __component=')
    const css=descriptor.styles.map(style=>compileStyle({source:style.content,filename:args.path,id,scoped:style.scoped}).code).join('\n')
    return {loader:'ts',resolveDir:dirname(args.path),contents:script+`\n__component.__scopeId=${JSON.stringify(id)};export default __component;const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.appendChild(style);`}
   })
  }
 }]})
 return result.outputFiles[0].text
}
