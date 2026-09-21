import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {dirname,basename} from 'node:path'
import {fileURLToPath} from 'node:url'
import {parse,compileScript,compileStyle} from '@vue/compiler-sfc'

/** Real overview, costs, parent navigation and Vue Router. Only authentication,
 * data transport and unrelated account/security panels are replaced. */
export async function adminOverviewBundle(mode:'app'|'component'='app'):Promise<string>{
  const websiteRequire=createRequire(new URL('../website/package.json',import.meta.url)),runtimeRequire=createRequire(websiteRequire.resolve('wrangler'))
  const {build}=runtimeRequire('esbuild'),admin=fileURLToPath(new URL('../website/src/admin/',import.meta.url))
  const client=await readFile(admin+'/client.ts','utf8'),permissions=client.slice(client.indexOf('export const roleNames:'),client.indexOf('async function token()'))
  const entry=mode==='app'?`
    import {createApp,h,ref} from 'vue';import {createRouter,createMemoryHistory,RouterView} from 'vue-router';import AdminView from './AdminView.vue';
    const key=ref(0),router=createRouter({history:createMemoryHistory(),routes:[{path:'/admin/:section?',component:AdminView}]});
    const app=createApp({render:()=>h(RouterView,{key:key.value})});app.use(router);
    window.__navigate=path=>router.push(path);window.__remount=()=>key.value++;window.__dispose=()=>app.unmount();
    router.push(window.__route||'/admin/overview').then(()=>router.isReady()).then(()=>app.mount('#app'));
  `:`
    import {createApp,h,reactive,ref} from 'vue';import AdminOverviewBilling from './AdminOverviewBilling.vue';
    const props=reactive({identity:'fixture-owner',canReadCosts:true,officialAccess:true,...window.__props}),component=ref();
    const app=createApp({render:()=>h(AdminOverviewBilling,{...props,ref:component})});app.mount('#app');
    window.__setProps=value=>Object.assign(props,value);window.__refreshOverview=force=>component.value.refresh(force);window.__dispose=()=>app.unmount();
  `
  const result=await build({stdin:{sourcefile:'admin-overview-fixture.ts',resolveDir:admin,contents:entry},bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',define:{'process.env.NODE_ENV':'"production"','import.meta.env.MODE':'"test"','__VUE_OPTIONS_API__':'true','__VUE_PROD_DEVTOOLS__':'false','__VUE_PROD_HYDRATION_MISMATCH_DETAILS__':'false'},plugins:[{
    name:'real-overview-with-synthetic-transport',setup(build:any){
      build.onResolve({filter:/^\.\/client$/},()=>({path:'client',namespace:'admin-fixture'}))
      build.onResolve({filter:/^\.\/Admin(Account|Mfa|Security)\.vue$/},(args:any)=>({path:args.path,namespace:'unrelated-panel'}))
      build.onLoad({filter:/.*/,namespace:'unrelated-panel'},()=>({loader:'js',contents:'export default {render:()=>null}'}))
      build.onLoad({filter:/.*/,namespace:'admin-fixture'},()=>({loader:'ts',resolveDir:admin,contents:`
        export type Role='owner'|'admin'|'support'|'finance'|'editor';
        ${permissions}
        export const request=(path,body)=>window.__request(path,body);export const localPreview=false;
        export const readPage=(path,filters={})=>request(path+'?'+new URLSearchParams(filters));
        export const login=async()=>window.__session;export const logout=async()=>{};
        export class ApiError extends Error {constructor(message,code,uncertain=false){super(message);this.code=code;this.uncertain=uncertain}}
        window.__ApiError=ApiError;
        export const savePending=()=>{},loadPending=()=>null,clearPending=()=>{},adminMfaStatus=async()=>({enrolled:true,recent:true});
        export const s=(row,key)=>String(row?.[key]??''),n=(row,key)=>Number(row?.[key]||0),label=value=>String(value??''),actionNames={'provider.funding.confirm':'确认累计充值与退款'};
        export const fmt=value=>new Intl.NumberFormat('zh-CN').format(Number(value||0));
        export const tokens=value=>value==null?'未记录':fmt(value);export const date=value=>value?new Date(String(value)).toISOString():'暂无';
        export {usd} from './money';
      `}))
      build.onLoad({filter:/\.css$/},async(args:any)=>({loader:'js',contents:`const style=document.createElement('style');style.textContent=${JSON.stringify(await readFile(args.path,'utf8'))};document.head.appendChild(style);`}))
      build.onLoad({filter:/\.vue$/},async(args:any)=>{
        const source=await readFile(args.path,'utf8'),{descriptor}=parse(source,{filename:args.path}),id='data-v-overview-test-'+basename(args.path).replace(/\W/g,'')
        const script=compileScript(descriptor,{id,inlineTemplate:true}).content.replace('export default','const __component=')
        const css=descriptor.styles.map(style=>compileStyle({source:style.content,filename:args.path,id,scoped:style.scoped}).code).join('\n')
        return {loader:'ts',resolveDir:dirname(args.path),contents:script+`\n__component.__scopeId=${JSON.stringify(id)};export default __component;const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.appendChild(style);`}
      })
    }
  }]})
  return result.outputFiles[0].text
}
