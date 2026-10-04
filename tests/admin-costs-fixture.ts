import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {dirname,basename} from 'node:path'
import {fileURLToPath} from 'node:url'
import {parse,compileScript,compileStyle} from '@vue/compiler-sfc'
import {currentBillPeriod} from '../website/src/admin/officialBills.ts'

export async function adminCostsBundle():Promise<string> {
  const websiteRequire=createRequire(new URL('../website/package.json',import.meta.url)),runtimeRequire=createRequire(websiteRequire.resolve('wrangler'))
  const {build}=runtimeRequire('esbuild'),admin=fileURLToPath(new URL('../website/src/admin/',import.meta.url))
  const result=await build({stdin:{sourcefile:'admin-costs-fixture.ts',resolveDir:admin,contents:`
    import {createApp,h,reactive} from 'vue';import AdminCosts from './AdminCosts.vue';
    const props=reactive({officialAccess:window.__officialAccess!==false});
    const app=createApp({render:()=>h(AdminCosts,{...props,onReconcile:value=>window.__reconciled=value,onFunding:value=>window.__funding=value})});app.mount('#app');
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
export function fundingBalanceFixture(now=Date.now()) {
 const value=balanceFixture(now)
 value.balances=[{currency:'USD',total:'19.70',paid:'19.70',granted:'0'}]
 return {...value,funding:{basis:'confirmed_paid_funding_minus_official_paid_balance',scope:'current_account_lifetime',currency:'USD',status:'ready',reason:null,cumulativeTopUps:'20',cumulativeCashRefunds:'0',netPaidFunding:'20',paidBalance:'19.70',grantedBalance:'0',usedPaid:'0.30',balanceFetchedAt:value.fetchedAt,confirmedAt:value.checkedAt,basisSource:'owner_confirmation'}}
}
export function costsFixture(period?:{from:string;to:string;timezone:string}){
  const today=new Date().toISOString().slice(0,10),selected=period||{from:today.slice(0,8)+'01',to:today,timezone:'UTC'},offset=selected.timezone==='Asia/Shanghai'?28800000:0
  return {from:new Date(Date.parse(selected.from+'T00:00:00Z')-offset).toISOString(),toExclusive:new Date(Date.parse(selected.to+'T00:00:00Z')+86400000-offset).toISOString(),timezone:selected.timezone,snapshotAt:new Date().toISOString(),officialBillingBasis:{kind:'provider_reporting_period',from:selected.from,to:selected.to,timezones:{openai:'UTC',deepseek:'Asia/Shanghai'}},totals:{charged_characters:23541,refunded_characters:0,known_cost_usd_exact:'0.123456789012',unpriced_requests:0},users:[],days:[],providers:[{provider:'openai',known_cost_usd_exact:'0.123456789011'},{provider:'deepseek',known_cost_usd_exact:'0.000000000001'}],officialBills:[] as Record<string,unknown>[],providerBalance:{balances:[{currency:'USD',total:'999999999999'}],fetched_at:'2020-01-01T00:00:00Z'}}
}
export function officialBillFixture(provider:'openai'|'deepseek',amount:string,period=costsFixture()){
  const offset=provider==='deepseek'?28800000:0,metadata=period.officialBillingBasis as Record<string,any>,basis=metadata.kind==='provider_current_month'?metadata.periods[provider]:metadata
  return {id:provider+'-fixture',provider,official_usd_exact:amount,official_usd:987654321,period_from:new Date(Date.parse(basis.from+'T00:00:00Z')-offset).toISOString(),period_to:new Date(Date.parse(basis.to+'T00:00:00Z')+86400000-offset).toISOString(),timezone:provider==='openai'?'UTC':'Asia/Shanghai',source:provider==='openai'?'openai_costs_api':'manual_statement',fetched_at:new Date().toISOString(),provisional:true,currentAccount:true,periodComplete:true,currency:'USD'}
}

export function nativeMonthFixture(data:ReturnType<typeof costsFixture>,now:number){
 const period=(timezone:string)=>({...currentBillPeriod(timezone,now),timezone})
 data.officialBillingBasis={kind:'provider_current_month',timezones:{openai:'UTC',deepseek:'Asia/Shanghai'},periods:{openai:period('UTC'),deepseek:period('Asia/Shanghai')}} as any
 return data
}

/** Synthetic equivalent of the existing native-month server route. Only fixture
 * responses use this; malformed periods in production are still rejected. */
export function costsQueryFixture(path:string,input:ReturnType<typeof costsFixture>,now=Date.now()){
 if(!/^(costs|billing-summary)\?/.test(path)||new URLSearchParams(path.split('?')[1]).get('officialCurrentMonth')!=='true')return input
 const data=structuredClone(input),previous=data.officialBillingBasis
 if(previous.kind==='provider_current_month')return data
 nativeMonthFixture(data,now)
 data.officialBills=data.officialBills.map(bill=>{
  const provider=bill.provider as 'openai'|'deepseek',before=officialBillFixture(provider,'0',input)
  if(bill.period_from!==before.period_from||bill.period_to!==before.period_to)return bill
  const after=officialBillFixture(provider,'0',data)
  return {...bill,period_from:after.period_from,period_to:after.period_to}
 })
 return data
}
