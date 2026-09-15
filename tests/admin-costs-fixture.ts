import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {dirname,basename} from 'node:path'
import {fileURLToPath} from 'node:url'
import {parse,compileScript,compileStyle} from '@vue/compiler-sfc'

export async function adminCostsBundle():Promise<string> {
  const websiteRequire=createRequire(new URL('../website/package.json',import.meta.url)),runtimeRequire=createRequire(websiteRequire.resolve('wrangler'))
  const {build}=runtimeRequire('esbuild'),admin=fileURLToPath(new URL('../website/src/admin/',import.meta.url))
  const result=await build({stdin:{sourcefile:'admin-costs-fixture.ts',resolveDir:admin,contents:`
    import {createApp,h,reactive} from 'vue';import AdminCosts from './AdminCosts.vue';
    const props=reactive({officialAccess:window.__officialAccess!==false});
    const app=createApp({render:()=>h(AdminCosts,props)});app.mount('#app');
    window.__setAccess=value=>props.officialAccess=value;window.__dispose=()=>app.unmount();
  `},bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',define:{'process.env.NODE_ENV':'"production"','__VUE_OPTIONS_API__':'true','__VUE_PROD_DEVTOOLS__':'false','__VUE_PROD_HYDRATION_MISMATCH_DETAILS__':'false'},plugins:[{
    name:'real-admin-costs-with-fake-api',setup(build:any){
      build.onResolve({filter:/^\.\/client$/},()=>({path:'client',namespace:'admin-fixture'}))
      build.onLoad({filter:/.*/,namespace:'admin-fixture'},()=>({loader:'ts',resolveDir:admin,contents:`
        export const request=(path,body)=>window.__request(path,body);export const localPreview=false;
        export const fmt=value=>new Intl.NumberFormat('zh-CN').format(Number(value||0));
        export const tokens=value=>value==null?'未记录':fmt(value);export const date=value=>value?new Date(String(value)).toISOString():'暂无';
        export {usd} from './money';
      `}))
      build.onLoad({filter:/\.vue$/},async(args:any)=>{
        const source=await readFile(args.path,'utf8'),{descriptor}=parse(source,{filename:args.path}),id='data-v-test-'+basename(args.path).replace(/\W/g,'')
        const script=compileScript(descriptor,{id,inlineTemplate:true}).content.replace('export default','const __component =')
        const css=descriptor.styles.map(style=>compileStyle({source:style.content,filename:args.path,id,scoped:style.scoped}).code).join('\n')
        return {loader:'ts',resolveDir:dirname(args.path),contents:script+`\n__component.__scopeId=${JSON.stringify(id)};export default __component;const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.appendChild(style);`}
      })
    }
  }]})
  return result.outputFiles[0].text
}

export function balanceFixture(now=Date.now()) {
  return {provider:'deepseek',available:true,balances:[{currency:'USD',total:'1234.123456789012',granted:'0.000000000001',paid:'1234.123456789011'},{currency:'CNY',total:'0.000000000009',granted:'0',paid:'0.000000000009'}],fetchedAt:new Date(now).toISOString(),snapshotAt:new Date(now).toISOString(),checkedAt:new Date(now).toISOString(),stale:false,
    sync:{status:'fresh',lastAttemptAt:new Date(now).toISOString(),lastError:null,lastErrorAt:null,nextRefreshAt:new Date(now+30000).toISOString(),refreshIntervalSeconds:30,staleAfterSeconds:120}}
}
export function costsFixture(){return {snapshotAt:new Date().toISOString(),totals:{charged_characters:23541,refunded_characters:0,known_cost_usd_exact:'0.123456789012',unpriced_requests:0},users:[],days:[],providers:[{provider:'openai',known_cost_usd_exact:'0.123456789011'},{provider:'deepseek',known_cost_usd_exact:'0.000000000001'}],officialBills:[],providerBalance:{balances:[{currency:'USD',total:'999999999999'}],fetched_at:'2020-01-01T00:00:00Z'}}}
