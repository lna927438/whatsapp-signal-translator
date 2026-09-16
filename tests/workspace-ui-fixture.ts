import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {parse,compileScript,compileStyle} from '@vue/compiler-sfc'

export async function workspaceUiBundle():Promise<string>{
 const wr=createRequire(new URL('../website/package.json',import.meta.url)),{build}=createRequire(wr.resolve('wrangler'))('esbuild')
 const directory=fileURLToPath(new URL('../src/renderer/src/components/',import.meta.url))
 const entry=`import {createApp,h,reactive} from 'vue';import AccountNavigation from './AccountNavigation.vue';import NotificationCenter from './NotificationCenter.vue';import {uiLanguage} from '../lib/uiLocale';
 const state=reactive({accounts:[],selectedId:'',unread:{},platform:'whatsapp',position:'top',theme:'charcoal',notice:false,snapshot:{notices:[],unread:0}});
 window.__events=[];window.__set=v=>Object.assign(state,v);window.__lang=v=>uiLanguage.value=v;window.__state=state;
 const app=createApp({render:()=>h('main',{class:'app-shell compact-shell','data-theme':state.theme,'data-platform':state.platform,style:'display:flex;flex-direction:column'},[
 h(AccountNavigation,{...state,onSelect:a=>{window.__events.push(['select',a.id]);state.selectedId=a.id},onRemove:a=>window.__events.push(['remove',a.id]),onRemark:a=>window.__events.push(['remark',a.id]),onReorder:ids=>{window.__events.push(['reorder',ids]);state.accounts=ids.map((id,tabOrder)=>({...state.accounts.find(a=>a.id===id),tabOrder}))}}),
 h('section',{style:'flex:1;padding:32px;background:var(--field);color:var(--muted)'},[h('h2','HelloDog'),h('p','Synthetic workspace / no real account'),h('button',{id:'notice-trigger',onClick:()=>state.notice=true},'Messages')]),
 state.notice?h(NotificationCenter,{snapshot:state.snapshot,onClose:()=>{state.notice=false;window.__events.push(['close'])},onUpdated:value=>{state.snapshot=value;window.__events.push(['updated'])}}):null
 ])});app.mount('#app');window.__dispose=()=>app.unmount();`
 const result=await build({stdin:{sourcefile:'workspace-fixture.ts',resolveDir:directory,contents:entry},bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',define:{'process.env.NODE_ENV':'"production"','__VUE_OPTIONS_API__':'true','__VUE_PROD_DEVTOOLS__':'false','__VUE_PROD_HYDRATION_MISMATCH_DETAILS__':'false'},plugins:[{name:'vue-ui-fixture',setup(build:any){
 build.onLoad({filter:/\.vue$/},async(args:any)=>{
 const {descriptor}=parse(await readFile(args.path,'utf8'),{filename:args.path}),id='data-v-workspace-'+args.path.split(/[\\/]/).at(-1)!.replace(/\W/g,'')
 const script=compileScript(descriptor,{id,inlineTemplate:true}).content.replace('export default','const __component=')
 const css=descriptor.styles.map(style=>compileStyle({source:style.content,filename:args.path,id,scoped:style.scoped}).code).join('\n')
 return{loader:'ts',resolveDir:dirname(args.path),contents:script+`\n__component.__scopeId=${JSON.stringify(id)};export default __component;const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.appendChild(style);`}
 })
 }}]})
 return result.outputFiles[0].text
}
