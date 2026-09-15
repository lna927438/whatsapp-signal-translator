<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AdminTable, { type Column } from './AdminTable.vue'
import AdminDialog from './AdminDialog.vue'
import { request, readPage, login, logout, localPreview, sections, roleNames, canView, canWrite, s,n,fmt,date,label,actionNames,
  ApiError,savePending,loadPending,clearPending,adminMfaStatus,type AdminSession,type Row,type Operation } from './client'
import './admin.css'
import AdminCosts from './AdminCosts.vue'
import AdminAccount from './AdminAccount.vue'
import AdminMfa from './AdminMfa.vue'
import AdminSecurity from './AdminSecurity.vue'
import {usd,tokens} from './client'

const route=useRoute(),router=useRouter()
const mfaOpen=ref(false)
const needMfa=()=>{password.value='';mfaOpen.value=true}
async function verifiedMfa(){mfaOpen.value=false;try{session.value=await request<AdminSession>('session');pending.value=loadPending(session.value.id);password.value='';loginError.value='';if(active.value==='login')await router.replace('/admin/overview');await load()}catch(e){loginError.value=message(e)}}
async function cancelMfa(){mfaOpen.value=false;password.value='';await signOut()}
const session=ref<AdminSession|null>(null),booting=ref(true),busy=ref(false),error=ref(''),notice=ref('')
const email=ref(import.meta.env.MODE==='admin-live'?'lna927438@gmail.com':''),password=ref(''),testRole=ref('owner'),loginBusy=ref(false),loginError=ref('')
const active=computed(()=>String(route.params.section||'overview'))
const section=computed(()=>sections.find(x=>x.id===active.value)||sections[0])
const workingSections=['overview','users','translations','costs','audit','account','announcements','security']
const navigation=computed(()=>sections.filter(x=>workingSections.includes(x.id)&&session.value&&canView(session.value.role,x.id)))
const rows=ref<Row[]>([]),overview=ref<Row>({}),snapshot=ref(''),hasMore=ref(false),offset=ref(0),query=ref(''),status=ref('')
const detail=ref<Row|null>(null),detailBusy=ref(false),detailError=ref('')
const profile=computed(()=>detail.value?.profile as Row||{}),wallet=computed(()=>detail.value?.wallet as Row||{})
const pending=ref<Operation|null>(null)
let loadRevision=0,detailRevision=0
let refreshTimer:ReturnType<typeof setInterval>|undefined
const write=(scope:'users'|'billing'|'content'|'roles')=>Boolean(session.value&&canWrite(session.value.role,scope))
const isSearch=computed(()=>['users','translations','orders','audit'].includes(active.value))
const filters=computed(()=>active.value==='users'?['active','blocked']:active.value==='translations'?['matched','mismatch','pending','not_charged','cache','free']:active.value==='orders'?['pending','paid','cancelled','failed']:[])
const columns=computed<Column[]>(()=>{
  const time={key:'created_at',title:'时间',format:(r:Row)=>date(r.created_at)}
  const account={key:'email',title:'用户'}
  switch(active.value){
    case 'users':return [account,{key:'username',title:'用户名'},{key:'admin_note',title:'管理员备注',format:r=>s(r,'admin_note')||'未备注'},{key:'last_seen_at',title:'客户端最近联机',format:r=>date(r.last_seen_at)},{key:'balance',title:'字符余额',format:r=>fmt(r.balance)},{key:'status',title:'状态',format:r=>label(r.status),tag:true},{key:'devices',title:'设备数'},time]
    case 'translations':return [{key:'request_id',title:'请求编号',mono:true},account,{key:'source_characters',title:'原文字符',format:r=>fmt(r.source_characters)},{key:'charged',title:'实际扣费',format:r=>fmt(r.charged)},{key:'total_tokens',title:'Tokens',format:r=>tokens(r.total_tokens)},{key:'cost_usd',title:'API 成本',format:r=>usd(r.cost_usd)},{key:'reconciliation',title:'核对结果',format:r=>label(r.reconciliation),tag:true},time]
    case 'orders':return [{key:'id',title:'订单编号',mono:true},account,{key:'plan_code',title:'套餐'},{key:'amount_cents',title:'金额',format:r=>`${s(r,'currency')} ${(n(r,'amount_cents')/100).toFixed(2)}`},{key:'characters',title:'字符数',format:r=>fmt(r.characters)},{key:'status',title:'状态',format:r=>label(r.status),tag:true},time]
    case 'plans':return [{key:'name',title:'套餐名称'},{key:'code',title:'代码',mono:true},{key:'included_characters',title:'包含字符',format:r=>fmt(r.included_characters)},{key:'price_cents',title:'价格',format:r=>`${s(r,'currency')} ${(n(r,'price_cents')/100).toFixed(2)}`},{key:'active',title:'状态',format:r=>r.active?'已启用':'已停用',tag:true}]
    case 'versions':return [{key:'version',title:'版本号'},{key:'channel',title:'渠道',format:r=>label(r.channel),tag:true},{key:'platform',title:'平台'},{key:'active',title:'状态',format:r=>r.active?'已启用':'草稿',tag:true},{key:'release_notes',title:'更新内容'},time]
    case 'announcements':return [{key:'title',title:'通知标题'},{key:'recipient_email',title:'接收用户',format:r=>s(r,'recipient_email')||'全部用户'},{key:'popup',title:'显示方式',format:r=>r.popup?'右下角弹窗':'仅消息中心'},{key:'active',title:'状态',format:r=>!r.active?'已停用':r.ends_at&&Date.parse(s(r,'ends_at'))<=Date.now()?'已结束':Date.parse(s(r,'starts_at'))>Date.now()?'待发送':'发送中',tag:true},{key:'displayed_count',title:'已弹出',format:r=>fmt(r.displayed_count)},{key:'dismissed_count',title:'已确认',format:r=>fmt(r.dismissed_count)},{key:'starts_at',title:'开始时间',format:r=>date(r.starts_at)}]
    case 'roles':return [account,{key:'role',title:'权限',format:r=>roleNames[s(r,'role') as keyof typeof roleNames]||s(r,'role')},{key:'status',title:'账号状态',format:r=>label(r.status),tag:true},time]
    default:return [{key:'actor_email',title:'操作人'},{key:'action',title:'操作',format:r=>actionNames[s(r,'action')]||s(r,'action')},{key:'target_id',title:'影响对象',mono:true},{key:'reason',title:'原因'},time]
  }
})
async function signIn(){loginBusy.value=true;loginError.value='';try{session.value=await login(email.value,password.value,testRole.value);password.value='';pending.value=loadPending(session.value.id);await router.replace('/admin/overview');await load()}catch(e){loginError.value=message(e)}finally{loginBusy.value=false}}
async function signOut(){++loadRevision;++detailRevision;mfaOpen.value=false;password.value='';await logout();session.value=null;rows.value=[];detail.value=null;pending.value=null;overview.value={};error.value='';loginError.value='';notice.value='';await router.replace('/admin/login')}
function message(e:unknown){return e instanceof Error?e.message:'暂时无法完成，请重试。'}
async function load(){
  if(!session.value)return
  const revision=++loadRevision;busy.value=true;error.value=''
  if(!canView(session.value.role,active.value)||!workingSections.includes(active.value)){await router.replace('/admin/overview');return}
  if(['costs','account','security'].includes(active.value)){busy.value=false;return}
  try{
    if(active.value==='overview'){const data=await request<Row>('overview');if(revision===loadRevision){overview.value=data;snapshot.value=s(data,'snapshotAt')}}
    else {const data=await readPage(active.value,{q:query.value,status:status.value,offset:offset.value});if(revision===loadRevision){rows.value=data.rows;hasMore.value=data.hasMore;snapshot.value=data.snapshotAt}}
  }catch(e){if(revision===loadRevision){error.value=message(e);if(e instanceof ApiError&&['unauthorized','admin_forbidden'].includes(e.code)){session.value=null;rows.value=[];overview.value={};detail.value=null;loginError.value=message(e)}}}
  finally{if(revision===loadRevision)busy.value=false}
}
async function search(){offset.value=0;await load()}
async function page(delta:number){offset.value=Math.max(0,offset.value+delta*25);await load()}
watch(active,()=>{query.value='';status.value='';offset.value=0;rows.value=[];detail.value=null;void load()})
async function userDetail(row:Row){
  const revision=++detailRevision;detailBusy.value=true;detailError.value='';detail.value={profile:row}
  try{const result=await request<Row>('user?userId='+encodeURIComponent(s(row,'id')||s(row,'user_id')));if(revision===detailRevision)detail.value=result}
  catch(e){if(revision===detailRevision)detailError.value=message(e)}finally{if(revision===detailRevision)detailBusy.value=false}
}
function closeDetail(){++detailRevision;detail.value=null}

interface Field {key:string;title:string;type?:'text'|'number'|'textarea'|'select'|'checkbox'|'datetime-local';options?:{value:string;title:string}[];min?:number;max?:number;maxLength?:number;required?:boolean}
interface Editor {action:string;target:string;targetName:string;data:Row;fields:Field[];reason:string;review:boolean;operationId:string;fixedTarget:boolean}
const editor=ref<Editor|null>(null),saving=ref(false),editError=ref(''),rawDetail=ref<Row|null>(null)
const editorFields=computed(()=>editor.value?.fields.filter(f=>f.key!=='recipient'||editor.value?.data.audience==='user')||[])
const field=(key:string,title:string,type:Field['type']='text',options?:string[]):Field=>({key,title,type,options:options?.map(v=>({value:v,title:label(v)})),required:type!=='checkbox'})
const editorBalance=computed(()=>editor.value?.action==='wallet.adjust'?Number(editor.value.data.expectedBalance)+Number(editor.value.data.amount):null)
function openEditor(action:string,target:string,targetName:string,data:Row,fields:Field[]){
  if(pending.value){notice.value='请先处理上次待确认的操作。';return}
  editError.value='';editor.value={action,target,targetName,data:{...data},fields,reason:'',review:false,operationId:crypto.randomUUID(),fixedTarget:Boolean(target)}
}
function adjust(){openEditor('wallet.add',s(profile.value,'id'),s(profile.value,'email'),{amount:10000},[{...field('amount','添加字符数','number'),min:1,max:1000000000}])}
function clearUserContent(){openEditor('user.clear-content',s(profile.value,'id'),s(profile.value,'email')+' · 清理已完成翻译的云端译文，无法恢复。保留余额、流水和请求编号；不删除平台聊天或其他设备上的本地副本。',{},[])}
function reconcile(data:Row){openEditor('cost.reconcile',s(data,'provider'),`${s(data,'provider')} · ${s(data,'from')} 至 ${s(data,'to')} · ${s(data,'timezone')||'GMT+8'}`,{from:data.from,to:data.to,timezone:data.timezone||'Asia/Shanghai',officialUsd:'',officialTokens:null,officialRequests:null,reference:''},[
  field('officialUsd','账单金额（USD，保留原始精度）'),{...field('officialTokens','账单 Tokens（没有可留空）','number'),min:0,required:false},{...field('officialRequests','账单调用数（没有可留空）','number'),min:0,required:false},field('reference','账单来源或导出文件名称')])}
function noteEdit(row:Row=profile.value){
  openEditor('user.note',s(row,'id'),s(row,'email'),{note:s(row,'admin_note'),expectedRevision:n(row,'note_revision')},[{...field('note','管理员备注','textarea'),required:false,maxLength:1000}])
}
async function userEdit(){
  openEditor('user.update',s(profile.value,'id'),s(profile.value,'email'),{status:s(profile.value,'status'),plan_code:s(profile.value,'plan_code')},[field('status','账号状态','select',['active','blocked'])])
}
async function createOrder(){
  const userId=s(profile.value,'id'),userEmail=s(profile.value,'email')
  try{const plans=await readPage('plans');openEditor('order.create',userId,userEmail,{plan_code:''},[{key:'plan_code',title:'充值套餐',type:'select',required:true,options:plans.rows.filter(r=>r.active&&n(r,'included_characters')>0).map(r=>({value:s(r,'code'),title:`${s(r,'name')} · ${fmt(r.included_characters)} 字符 · ${s(r,'currency')} ${(n(r,'price_cents')/100).toFixed(2)}`}))}])}catch(e){detailError.value=message(e)}
}
function refund(row:Row){openEditor('translation.refund',s(row,'ledger_id'),`${s(row,'email')} · 请求 ${s(row,'request_id')} · 补偿 ${fmt(row.charged)} 字符`,{},[])}
function settle(row:Row){openEditor('order.settle',s(row,'id'),`${s(row,'email')} · ${fmt(row.characters)} 字符 · ${s(row,'currency')} ${(n(row,'amount_cents')/100).toFixed(2)}`,{reference:''},[field('reference','已收款凭证编号')])}
function cancelOrder(row:Row){openEditor('order.cancel',s(row,'id'),`${s(row,'email')} · 订单 ${s(row,'id')}`,{},[])}
function planEdit(row:Row={}){
  openEditor('plan.save',s(row,'code'),s(row,'name')||'新套餐',{name:s(row,'name'),characters:n(row,'included_characters'),price:n(row,'price_cents'),currency:s(row,'currency')||'USD',active:Boolean(row.active)},[
    field('name','套餐名称'),{...field('characters','包含字符','number'),min:0,max:1000000000},{...field('price','价格（分，例如 990 表示 9.90）','number'),min:0,max:100000000},field('currency','币种','select',['USD','CNY']),field('active','启用此套餐','checkbox')])
}
function versionEdit(row:Row={}){
  openEditor('version.save',s(row,'version'),s(row,'version')||'新版本',{channel:s(row,'channel')||'beta',url:s(row,'download_url'),sha256:s(row,'sha256'),notes:s(row,'release_notes'),active:Boolean(row.active)},[
    field('channel','发布渠道','select',['beta','stable']),{...field('url','HTTPS 下载地址'),required:false},{...field('sha256','文件 SHA256 校验值'),required:false},{...field('notes','更新内容','textarea'),required:false},field('active','启用此版本记录','checkbox')])
}
function localTime(value:unknown){const d=value?new Date(String(value)):new Date();return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16)}
function announcementEdit(row:Row={},recipient=''){
  openEditor('notice.save',s(row,'id')||crypto.randomUUID(),recipient||s(row,'recipient_email')||'全部用户',{
    title:s(row,'title'),body:s(row,'body'),level:s(row,'level')||'info',active:row.id?Boolean(row.active):true,
    starts_at:localTime(row.starts_at),ends_at:row.ends_at?localTime(row.ends_at):row.id?'':localTime(new Date(Date.now()+7*86400000)),popup:row.id?Boolean(row.popup):true,
    audience:recipient||row.target_user_id?'user':'all',recipient:recipient||s(row,'recipient_email'),action:s(row,'action')||'none',expectedRevision:n(row,'revision')},[
    {...field('title','通知标题'),maxLength:120},{...field('body','通知内容','textarea'),maxLength:3000},
    {key:'audience',title:'接收范围',type:'select',required:true,options:[{value:'all',title:'全部用户'},{value:'user',title:'指定用户'}]},
    {...field('recipient','用户登录邮箱'),maxLength:254},field('level','级别','select',['info','warning','critical']),
    {key:'action',title:'弹窗按钮',type:'select',required:true,options:[{value:'none',title:'知道了'},{value:'website',title:'前往官网'},{value:'download',title:'前往官网下载更新'}]},
    field('starts_at','开始时间','datetime-local'),{...field('ends_at','结束时间（可留空）','datetime-local'),required:false},
    field('popup','在客户端右下角弹出','checkbox'),field('active','启用并按计划发送','checkbox')])
}
function roleEdit(row:Row={}){
  const roleField:Field={key:'role',title:'管理员权限',type:'select',required:true,options:[...Object.entries(roleNames).map(([value,title])=>({value,title})),{value:'none',title:'移除管理权限'}]}
  openEditor('role.set',s(row,'user_id'),s(row,'email')||'指定用户',{role:s(row,'role')||'support'},[roleField])
}
async function review(){
  if(!editor.value)return
  const current=editor.value;editError.value=''
  if(current.action==='notice.save'){
    if(current.data.ends_at&&new Date(String(current.data.ends_at))<=new Date(String(current.data.starts_at))){editError.value='结束时间须晚于开始时间。';return}
    current.targetName=current.data.audience==='user'?String(current.data.recipient).trim():'全部用户'
  }
  if(current.action==='role.set'){
    saving.value=true
    try{const data=await request<Row>('user?userId='+encodeURIComponent(current.target.trim()));if(editor.value!==current)return;current.targetName=s(data.profile as Row,'email')}
    catch(e){editError.value=message(e);return}finally{saving.value=false}
  }
  current.review=true
}
function operation(e:Editor):Operation{
  const data={...e.data}
  if(e.action==='cost.reconcile')for(const key of ['officialTokens','officialRequests'])data[key]=data[key]==null||data[key]===''?null:Number(data[key])
  if(['announcement.save','notice.save'].includes(e.action)){data.starts_at=new Date(String(data.starts_at)).toISOString();data.ends_at=data.ends_at?new Date(String(data.ends_at)).toISOString():'';if(e.action==='notice.save'&&data.audience==='all')data.recipient=''}
  return {operationId:e.operationId,action:e.action,target:e.target.trim(),reason:e.reason.trim()||actionNames[e.action]+'操作',data}
}
async function submit(op?:Operation){
  if(!session.value)return
  const id=session.value.id, current=op|| (editor.value?operation(editor.value):null)
  if(!current)return
  saving.value=true;editError.value='';notice.value=''
  try{
    savePending(id,current);pending.value=current
    const result=await request<Row>('mutate',current)
    clearPending(id);pending.value=null;editor.value=null
    notice.value=`${actionNames[current.action]}已完成${result.balanceAfter!=null?`，本次操作后的余额为 ${fmt(result.balanceAfter)} 字符`:''}。`
    if(current.action==='cost.reconcile')rawDetail.value=result
    if(current.action==='role.set'||current.action==='user.update'){session.value=await request<AdminSession>('session')}
    await load()
    if(detail.value)await userDetail(profile.value)
  }catch(e){
    editError.value=message(e)
    if(e instanceof ApiError&&!e.uncertain){clearPending(id);pending.value=null}
    if(!editor.value)notice.value=message(e)
  }finally{saving.value=false}
}
function closeEditor(){if(!saving.value)editor.value=null}
async function resume(){
  if(!pending.value||!session.value)return
  const p=pending.value;const actor=session.value.id;saving.value=true;editError.value=''
  try{
    const result=await request<{found:boolean;result:Row|null}>('operation?operationId='+encodeURIComponent(p.operationId))
    if(result.found){clearPending(actor);pending.value=null;editor.value=null;notice.value=`已确认：${actionNames[p.action]}已完成，无需重复操作。`;await load();if(detail.value)await userDetail(profile.value);return}
    editor.value={action:p.action,target:p.target,targetName:p.target,data:p.data,fields:[],reason:p.reason,review:true,operationId:p.operationId,fixedTarget:true}
    editError.value='尚未查到已完成的记录。可按原编号重试，已完成的操作不会重复执行。'
  }catch(e){notice.value=message(e)}finally{saving.value=false}
}
const ledgerColumns:Column[]=[{key:'type',title:'类型',format:r=>label(r.type)},{key:'characters',title:'字符变化',format:r=>`${n(r,'characters')>0?'+':''}${fmt(r.characters)}`},{key:'balance_after',title:'记账后余额',format:r=>fmt(r.balance_after)},{key:'created_at',title:'时间',format:r=>date(r.created_at)}]
const deviceColumns:Column[]=[{key:'device_name',title:'设备'},{key:'platform',title:'系统'},{key:'app_version',title:'版本'},{key:'status',title:'状态',format:r=>label(r.status)},{key:'last_seen_at',title:'上次登记',format:r=>date(r.last_seen_at)}]
onMounted(async()=>{window.addEventListener('hellodog:admin-mfa',needMfa);try{await adminMfaStatus();session.value=await request<AdminSession>('session');pending.value=loadPending(session.value.id);if(active.value==='login')await router.replace('/admin/overview');await load()}catch(e){if(e instanceof ApiError&&!['unauthorized','not_configured','mfa_required'].includes(e.code))loginError.value=message(e)}finally{booting.value=false}})
async function refreshLive(){
  if(!session.value||busy.value||document.visibilityState!=='visible'||['costs','account'].includes(active.value))return
  await load()
  const id=s(profile.value,'id'),revision=detailRevision
  if(id&&!editor.value&&!saving.value){try{const value=await request<Row>('user?userId='+encodeURIComponent(id));if(revision===detailRevision&&detail.value)detail.value=value}catch(e){detailError.value=message(e)}}
}
onMounted(()=>{refreshTimer=setInterval(()=>void refreshLive(),5000)})
onUnmounted(()=>{++loadRevision;++detailRevision;clearInterval(refreshTimer);window.removeEventListener('hellodog:admin-mfa',needMfa)})
</script>

<template>
  <div class="admin-root">
    <AdminMfa v-if="mfaOpen" @verified="verifiedMfa" @cancel="cancelMfa" />
    <div v-if="booting" class="adm-login"><p>正在打开管理后台…</p></div>
    <main v-else-if="!session" class="adm-login">
      <div class="adm-login-brand"><img src="/hellodog-icon.webp" alt="HelloDog" /><strong>HelloDog</strong><span>管理后台</span></div>
      <form class="adm-login-card" @submit.prevent="signIn"><span class="adm-eyebrow">HELLODOG CONSOLE</span><h1>登录管理后台</h1><p>管理客户端用户、添加字符和查看实际用量。</p>
        <div v-if="localPreview" class="adm-preview-note"><b>本地测试环境</b><span>这里使用独立的样例数据。可实际操作，修改会在本机保存。</span></div>
        <template v-if="localPreview"><label>测试身份<select v-model="testRole"><option v-for="(name,role) in roleNames" :key="role" :value="role">{{ name }}</option><option value="user">普通用户（验证权限拦截）</option></select></label></template>
        <template v-else><label>管理员邮箱<input v-model="email" type="email" autocomplete="username" required /></label><label>密码<input v-model="password" type="password" autocomplete="current-password" required /></label></template>
        <p v-if="loginError" class="adm-error" role="alert">{{ loginError }}</p><button class="adm-primary" :disabled="loginBusy">{{ loginBusy?'正在登录…':localPreview?'进入本地测试后台':'登录管理后台' }}</button>
        <small>使用客户端现有登录密码。登录后可在「管理员账号」中设置新密码。</small>
      </form><span class="adm-login-foot">HelloDog · 让每一句，都被听懂。</span>
    </main>
    <template v-else>
      <aside class="adm-sidebar"><RouterLink to="/admin/overview" class="adm-brand"><img src="/hellodog-icon.webp" alt="" /><span>HelloDog<small>管理后台</small></span></RouterLink>
        <span class="adm-nav-label">工作空间</span><nav aria-label="管理导航"><RouterLink v-for="item in navigation" :key="item.id" :to="'/admin/'+item.id" :class="{selected:active===item.id}"><span aria-hidden="true">{{ item.icon }}</span>{{ item.name }}<i v-if="item.id==='translations'">账</i></RouterLink></nav>
        <div class="adm-sidebar-bottom"><span :class="localPreview?'adm-env local':'adm-env'">● {{ localPreview?'本地测试 · 样例数据':'客户端真实数据' }}</span><div class="adm-admin"><b>{{ roleNames[session.role] }}</b><span :title="session.email">{{ session.email }}</span></div><button @click="signOut">退出登录 ↗</button></div>
      </aside>
      <main class="adm-main"><header class="adm-topbar"><span>HelloDog / {{ section.name }}</span><span>{{ localPreview?'数据仅保存在这台电脑':'与客户端共用云端账本' }}<b class="adm-avatar">{{ session.email.slice(0,1).toUpperCase() }}</b></span></header>
        <div class="adm-content"><div class="adm-heading"><div><span class="adm-eyebrow">{{ active==='overview'?'WORKSPACE OVERVIEW':'HELLODOG MANAGEMENT' }}</span><h1>{{ section.name }}</h1><p>{{ section.hint }}</p></div><button v-if="!['costs','account'].includes(active)" class="adm-button" :disabled="busy" @click="load">{{ busy?'读取中…':'↻ 刷新数据' }}</button></div>
          <div v-if="localPreview" class="adm-environment"><span>本地测试版</span>使用样例账号、订单和翻译记录，所有改动仅在本机生效。</div>
          <div v-if="pending" class="adm-pending" role="status"><div><b>有一项操作等待确认</b><p>{{ actionNames[pending.action] }} · {{ pending.operationId }}</p></div><button class="adm-button" :disabled="saving" @click="resume">核对原操作</button></div>
          <p v-if="notice" class="adm-notice" role="status">{{ notice }}<button aria-label="关闭提示" @click="notice=''">×</button></p>
          <div v-if="error" class="adm-error" role="alert">{{ error }}<button class="adm-button" @click="load">重新加载</button><small v-if="snapshot">下方是上次成功读取的数据：{{ date(snapshot) }}</small></div>
          <template v-if="active==='overview'">
            <section class="adm-stat-grid"><article><span>客户端用户</span><strong>{{ fmt(overview.users) }}</strong><small>{{fmt(overview.recentClients)}} 位在最近 2 分钟联机</small></article><article><span>今日已扣字符</span><strong>{{fmt(overview.todayCharacters)}}</strong><small>GMT+8 · 云端实际流水</small></article><article><span>实际 API Tokens</span><strong>{{tokens((overview.costs as Row)?.total_tokens)}}</strong><small>{{fmt((overview.costs as Row)?.metered_requests)}} 条请求有用量回执</small></article><article><span>已核算 API 成本 · USD</span><strong class="adm-cost-value">{{usd((overview.costs as Row)?.known_cost_usd_exact??(overview.costs as Row)?.known_cost_usd??(overview.costs as Row)?.cost_usd)}}</strong><small>{{fmt((overview.costs as Row)?.unpriced_requests)}} 条尚未核算</small></article></section>
            <section class="adm-overview-grid"><article class="adm-card"><h2>用户管理</h2><p>添加的字符写入客户端共用的钱包。客户端连接正常时，约 5 秒内刷新余额。</p><div class="adm-shortcuts"><RouterLink to="/admin/users">查找用户 · 添加字符 <span>↗</span></RouterLink><RouterLink to="/admin/translations">查看翻译记录 <span>↗</span></RouterLink><RouterLink to="/admin/costs">查看 Tokens 与费用 <span>↗</span></RouterLink></div></article><article class="adm-card"><h2>当前数据</h2><dl class="adm-status-list"><div><dt>来源</dt><dd>{{localPreview?'本机样例数据库':'客户端共用云端数据库'}}</dd></div><div><dt>刷新频率</dt><dd>每 5 秒</dd></div><div><dt>等待结果的翻译</dt><dd>{{fmt(overview.pendingTranslations)}} 条</dd></div><div><dt>翻译对账异常</dt><dd>{{fmt((overview.costs as Row)?.mismatches)}} 条</dd></div></dl><p class="adm-help">费用缺少完整用量时显示未核算。套餐与支付暂不启用。</p></article></section>
          </template>
          <AdminCosts v-else-if="active==='costs'" :official-access="session.role==='owner'" @reconcile="reconcile" />
          <AdminAccount v-else-if="active==='account'" :session="session" />
          <AdminSecurity v-else-if="active==='security'" />
          <section v-else class="adm-card adm-list-card" :aria-busy="busy">
            <form class="adm-toolbar" @submit.prevent="search"><div class="adm-search" v-if="isSearch"><span aria-hidden="true">⌕</span><input v-model="query" :placeholder="active==='translations'?'搜索请求编号或用户邮箱':active==='audit'?'搜索操作编号、用户编号或操作人':'搜索邮箱、用户名、备注或编号'" aria-label="搜索记录" maxlength="160" /><button type="submit" :disabled="busy">搜索</button></div><select v-if="filters.length" v-model="status" aria-label="筛选状态" @change="search"><option value="">全部状态</option><option v-for="value in filters" :key="value" :value="value">{{ label(value) }}</option></select>
              <button v-if="active==='plans'&&write('billing')" class="adm-primary" type="button" @click="planEdit()">＋ 新建套餐</button><button v-if="active==='versions'&&write('content')" class="adm-primary" type="button" @click="versionEdit()">＋ 新增版本</button><button v-if="active==='announcements'&&write('content')" class="adm-primary" type="button" @click="announcementEdit()">＋ 新建通知</button><button v-if="active==='roles'&&write('roles')" class="adm-primary" type="button" @click="roleEdit()">＋ 授予管理权限</button>
            </form>
            <p v-if="active==='announcements'" class="adm-table-note">适用于 HelloDog 0.5.7 及以后版本。在线客户端通常在 30 秒内同步；离线用户下次打开时接收仍在有效期内的通知。已弹出和已确认按用户统计，不代表全部用户都已收到。停用或编辑通知会在下一次同步时生效。</p><p v-if="active==='translations'" class="adm-table-note">显示已到达云端的请求。客户端直接从缓存恢复的译文不会新增云端扣费记录。</p><p v-if="active==='orders'" class="adm-table-note">在「用户与余额」中打开用户详情，可创建人工充值订单。确认收款后才增加字符。</p><p v-if="active==='roles'" class="adm-table-note">客服可查用户和翻译；财务可处理余额与订单；内容运营可管理版本与公告。权限由服务端再次核对。</p>
            <AdminTable :rows="rows" :columns="columns" :empty="busy?'正在读取记录…':undefined"><template #actions="{row}">
              <template v-if="active==='users'"><button class="adm-link" @click="userDetail(row)">查看用户 →</button><button v-if="write('users')" class="adm-link" @click="noteEdit(row)">备注</button></template>
              <template v-else-if="active==='translations'"><button class="adm-link" @click="rawDetail=row">详情</button><button v-if="write('billing')&&n(row,'debit_count')===1&&n(row,'charged')>0&&!n(row,'refunded')&&row.ledger_id" class="adm-link" @click="refund(row)">补偿</button></template>
              <template v-else-if="active==='orders'"><button class="adm-link" @click="rawDetail=row">详情</button><template v-if="write('billing')&&row.provider==='manual'&&row.status==='pending'"><button class="adm-link" @click="settle(row)">确认收款</button><button class="adm-link" @click="cancelOrder(row)">取消</button></template></template>
              <button v-else-if="active==='plans'&&write('billing')" class="adm-link" @click="planEdit(row)">编辑</button><button v-else-if="active==='versions'&&write('content')" class="adm-link" @click="versionEdit(row)">编辑</button><button v-else-if="active==='announcements'&&write('content')" class="adm-link" @click="announcementEdit(row)">编辑</button><button v-else-if="active==='roles'&&write('roles')" class="adm-link" @click="roleEdit(row)">修改权限</button><button v-else-if="active==='audit'" class="adm-link" @click="rawDetail=row">详情</button>
            </template></AdminTable><footer class="adm-list-footer"><span>第 {{ Math.floor(offset/25)+1 }} 页 · 本页 {{ rows.length }} 条</span><div><button class="adm-button" :disabled="busy||!offset" @click="page(-1)">上一页</button><button class="adm-button" :disabled="busy||!hasMore" @click="page(1)">下一页</button></div></footer>
          </section>
          <footer class="adm-content-footer"><span>HelloDog 管理后台 · {{ localPreview?'本地验收版':'管理空间' }}</span><span v-if="snapshot">数据读取于 {{ date(snapshot) }}</span></footer>
        </div>
      </main>
      <AdminDialog v-if="detail" title="用户详情" @close="closeDetail"><div class="adm-dialog-body"><div class="adm-user-heading"><span class="adm-avatar">{{ s(profile,'email').slice(0,1).toUpperCase() }}</span><div><h3>{{ s(profile,'email') }}</h3><small class="mono">{{ s(profile,'id') }}</small></div><span class="adm-tag">{{ label(profile.status) }}</span></div>
        <p v-if="detailBusy">正在读取用户详情…</p><p v-else-if="detailError" class="adm-error">{{ detailError }}</p><template v-else>
          <div class="adm-wallet"><div><span>字符余额</span><strong>{{ fmt(wallet.balance) }}</strong></div><div><span>翻译预留</span><b>{{ fmt(wallet.reserved_characters) }}</b></div><div><span>可用字符</span><b>{{ fmt(n(wallet,'balance')-n(wallet,'reserved_characters')) }}</b></div></div>
          <section class="adm-user-note"><span>管理员备注 · 仅后台可见</span><p>{{ s(profile,'admin_note') || '未填写备注' }}</p><small v-if="profile.note_updated_at">更新于 {{ date(profile.note_updated_at) }}</small><button v-if="write('users')" class="adm-link" @click="noteEdit()">编辑备注</button></section><div class="adm-detail-actions"><button v-if="write('billing')" class="adm-primary" @click="adjust">添加字符</button><button v-if="write('users')" class="adm-button" @click="userEdit">账号状态</button><button v-if="session?.role=== 'owner'" class="adm-button" @click="clearUserContent">清理云端译文</button><button v-if="write('content')" class="adm-button" @click="announcementEdit({},s(profile,'email'))">发送通知</button></div>
          <p :class="n(wallet,'balance')===n(detail,'ledgerBalance')?'adm-help':'adm-error'">钱包 {{ fmt(wallet.balance) }} · 全部流水合计 {{ fmt(detail.ledgerBalance) }} · {{ n(wallet,'balance')===n(detail,'ledgerBalance')?'余额一致':'余额与流水不一致，请核查历史入账' }}<br />翻译对账异常 {{ fmt(detail.mismatches) }} 条</p>
          <p class="adm-help">API Tokens：{{tokens((detail.costs as Row)?.total_tokens)}} · 已核算费用：{{usd((detail.costs as Row)?.known_cost_usd_exact??(detail.costs as Row)?.known_cost_usd??(detail.costs as Row)?.cost_usd)}} · 未核算请求：{{fmt((detail.costs as Row)?.unpriced_requests)}}</p><h3>设备 <small>最近 {{ (detail.devices as Row[]||[]).length }} / {{ detail.deviceCount }} 台</small></h3><AdminTable :rows="detail.devices as Row[]||[]" :columns="deviceColumns" empty="暂未登记设备。" />
          <h3>钱包流水 <small>最近 {{ (detail.ledger as Row[]||[]).length }} / {{ detail.ledgerCount }} 条</small></h3><AdminTable :rows="detail.ledger as Row[]||[]" :columns="ledgerColumns" empty="暂时没有钱包流水。" /><p class="adm-help">读取于 {{ date(detail.snapshotAt) }}。设备时间表示上次登记时间，不代表此刻在线。</p>
        </template></div></AdminDialog>
      <AdminDialog v-if="rawDetail" title="记录详情" @close="rawDetail=null"><div class="adm-dialog-body"><dl v-if="rawDetail.officialUsd!=null" class="adm-record"><dt>API 服务</dt><dd>{{rawDetail.provider}}</dd><dt>账期（{{rawDetail.timezone==='UTC'?'UTC':'GMT+8'}}）</dt><dd>{{rawDetail.from}} 至 {{rawDetail.to}}</dd><dt>核对结果</dt><dd>{{label(rawDetail.status)}}</dd><dt>官方账单金额</dt><dd>{{usd(rawDetail.officialUsdExact??rawDetail.officialUsd)}}</dd><dt>按回执核算（参考）</dt><dd>{{usd((rawDetail.calculated as Row)?.cost_usd_exact??(rawDetail.calculated as Row)?.cost_usd)}}</dd><dt>费用差额</dt><dd>{{rawDetail.differenceUsd==null?(rawDetail.comparisonReason==='local_account_scope_unavailable'?'历史调用缺少账号归属，暂不计算差额':'数据不完整，暂不计算差额'):usd(rawDetail.differenceUsdExact??rawDetail.differenceUsd)}}</dd><dt>官方 / 已记录 Tokens</dt><dd>{{rawDetail.officialTokens==null?'未提供':tokens(rawDetail.officialTokens)}} / {{tokens((rawDetail.calculated as Row)?.total_tokens)}}</dd><dt>官方 / 云端请求数</dt><dd>{{rawDetail.officialRequests==null?'未提供':fmt(rawDetail.officialRequests)}} / {{fmt((rawDetail.calculated as Row)?.provider_requests??(rawDetail.calculated as Row)?.requests)}}</dd><dt>未核算请求</dt><dd>{{fmt((rawDetail.calculated as Row)?.unpriced_requests)}}</dd><dt>账单来源</dt><dd>{{rawDetail.reference}}</dd></dl><dl v-else class="adm-record"><template v-for="(value,key) in rawDetail" :key="key"><dt>{{ ({request_id:'请求编号',email:'用户邮箱',source_characters:'原文字符',usage_characters:'用量记录字符',charged:'实际扣费',refunded:'补偿字符',reconciliation:'核对结果',state:'处理状态',error_code:'异常代码',provider:'服务',model:'模型',latency_ms:'耗时（毫秒）',created_at:'时间',debit_count:'扣费笔数',ledger_id:'扣费流水编号',user_id:'用户编号',id:'记录编号',action:'操作',actor_email:'操作人',reason:'原因',result:'修改结果',target_id:'影响对象',amount_cents:'金额（分）',currency:'币种',characters:'字符数',status:'状态',paid_at:'入账时间',provider_order_id:'收款凭证',plan_code:'套餐',source_language:'原文语言',target_language:'目标语言',cache_hit:'缓存命中',expires_at:'原请求期限',actor_id:'操作人编号',actor_role:'操作人角色',cost_provider:'API 服务',cost_model:'实际模型',provider_response_id:'API 响应编号',provider_request_id:'API 请求编号',input_tokens:'输入 Tokens',cached_tokens:'缓存命中 Tokens',output_tokens:'输出 Tokens',total_tokens:'总 Tokens',reasoning_tokens:'输出中包含的推理 Tokens',cost_usd:'核算费用（USD）',cost_status:'核算状态',price_version:'官方单价版本',price_period:'计费时段',price_time_source:'计费时间依据',input_rate:'未缓存输入单价（USD/百万 Tokens）',cached_rate:'缓存输入单价（USD/百万 Tokens）',output_rate:'输出单价（USD/百万 Tokens）',provider_started_at:'API 开始时间',usage_recorded_at:'用量入账时间',provider_created_at:'API 返回时间',http_status:'API 响应状态',officialUsd:'官方账单费用（USD）',officialTokens:'官方 Tokens',officialRequests:'官方请求数',calculated:'客户端用量核算',differenceUsd:'费用差额（USD）',reference:'账单来源',from:'开始日期',to:'结束日期'} as Record<string,string>)[key]||key }}</dt><dd>{{ typeof value==='object'&&value!==null?JSON.stringify(value,null,2):label(value) }}</dd></template></dl></div></AdminDialog>
      <AdminDialog v-if="editor" :title="actionNames[editor.action]" :busy="saving" @close="closeEditor"><form class="adm-dialog-body adm-edit-form" @submit.prevent="editor.review||['wallet.add','user.note'].includes(editor.action)?submit():review()">
        <div class="adm-target"><span>本次影响对象</span><b>{{ editor.action==='notice.save'?(editor.data.audience==='user'?(editor.data.recipient||'填写接收邮箱'):'全部用户'):editor.targetName }}</b><small v-if="editor.target" class="mono">{{ editor.target }}</small></div>
        <template v-if="!editor.review"><label v-if="['plan.save','version.save','role.set'].includes(editor.action)">{{ editor.action==='plan.save'?'套餐代码':editor.action==='version.save'?'版本号':'用户编号（用户详情中可查看）' }}<input v-model="editor.target" :disabled="editor.fixedTarget" required maxlength="160" /></label>
          <label v-for="f in editorFields" :key="f.key" :class="{check:f.type==='checkbox'}">{{ f.title }}<textarea v-if="f.type==='textarea'" v-model="editor.data[f.key] as string" :required="f.required" rows="4" :maxlength="f.maxLength||10000" /><select v-else-if="f.type==='select'" v-model="editor.data[f.key]" :required="f.required"><option value="" disabled>请选择</option><option v-for="o in f.options" :key="o.value" :value="o.value">{{ o.title }}</option></select><input v-else-if="f.type==='checkbox'" v-model="editor.data[f.key]" type="checkbox" /><input v-else-if="f.type==='number'" v-model.number="editor.data[f.key]" type="number" step="1" :min="f.min" :max="f.max" required /><input v-else v-model="editor.data[f.key] as string" :type="f.type||'text'" :required="f.required" :maxlength="f.maxLength||(f.key==='sha256'?64:f.key==='url'?2000:160)" /></label>
          <p v-if="editor.action==='user.note'" class="adm-help">仅管理员可见，不修改用户名。留空保存可清除备注。{{String(editor.data.note||'').length}} / 1000</p><label v-if="editor.action!=='user.note'">{{['wallet.add','notice.save'].includes(editor.action)?'备注（选填）':'操作原因'}}<textarea v-model="editor.reason" :required="!['wallet.add','notice.save'].includes(editor.action)" :minlength="['wallet.add','notice.save'].includes(editor.action)?undefined:3" maxlength="500" rows="2" placeholder="可填写备注；添加字符会自动记录操作原因" /></label>
        </template>
        <template v-else><div class="adm-review"><h3>请核对本次修改</h3><template v-if="editor.action==='wallet.adjust'"><p>当前读取余额：<b>{{ fmt(editor.data.expectedBalance) }}</b> 字符</p><p>本次{{ Number(editor.data.amount)>0?'增加':'扣减' }}：<b>{{ fmt(Math.abs(Number(editor.data.amount))) }}</b> 字符</p><p>调整后余额：<b>{{ fmt(editorBalance) }}</b> 字符</p></template><dl v-else><template v-for="f in editorFields" :key="f.key"><dt>{{ f.title }}</dt><dd>{{ f.options?.find(o=>o.value===editor?.data[f.key])?.title || (typeof editor.data[f.key]==='boolean'?(editor.data[f.key]?'是':'否'):label(editor.data[f.key])) }}</dd></template></dl><p>原因：{{ editor.reason }}</p></div><p v-if="editor.action==='order.settle'" class="adm-help">确认表示你已核实收款，此操作会增加用户字符余额。</p><p v-if="editor.action==='version.save'" class="adm-help">这里只保存版本记录，不会上传文件或自动发布客户端。</p><p class="adm-help">操作编号：<span class="mono">{{ editor.operationId }}</span></p></template>
        <div v-if="editor.action==='notice.save'" class="adm-popup-preview"><small>HelloDog · {{editor.data.popup?'弹窗预览':'消息中心预览'}}</small><h3>{{editor.data.title||'通知标题'}}</h3><p>{{editor.data.body||'在这里预览用户会看到的内容'}}</p><footer><span>查看消息中心</span><b>{{editor.data.action==='download'?'前往官网更新':editor.data.action==='website'?'前往官网':'知道了'}}</b></footer></div><p v-if="editError" class="adm-error" role="alert">{{ editError }}</p><footer class="adm-dialog-footer"><button v-if="editor.review&&!pending" type="button" class="adm-button" :disabled="saving" @click="editor.review=false">返回修改</button><button type="button" class="adm-button" :disabled="saving" @click="closeEditor">{{ pending?'稍后处理':'取消' }}</button><button class="adm-primary" :disabled="saving">{{ saving?'正在保存…':pending?'按原编号继续':editor.action==='user.note'?'保存备注':editor.action==='wallet.add'?'添加字符':editor.review?(editor.action==='notice.save'?(editor.data.active?'确认发送':'保存停用状态'):'确认保存'):'下一步：核对修改' }}</button></footer>
      </form></AdminDialog>
    </template>
  </div>
</template>
