import { createClient } from '@supabase/supabase-js'
import { apiBase } from '../lib/supabase'
import { authCaptcha } from '../lib/authChallenge'

export type Row = Record<string, unknown>
export type Role = 'owner' | 'admin' | 'support' | 'finance' | 'editor'
export interface AdminSession { id:string; email:string; role:Role; singleAdmin?:boolean }
export interface Page { rows:Row[]; hasMore:boolean; offset:number; snapshotAt:string }
export interface Operation { operationId:string; action:string; target:string; reason:string; data:Row }
export const localPreview=import.meta.env.MODE==='admin-local' && ['127.0.0.1','localhost'].includes(location.hostname)
const base=localPreview?'':apiBase
const configUrl=String(import.meta.env.VITE_SUPABASE_URL||'')
const configKey=String(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY||'')
// Admin sessions survive a page refresh, but not closing the browser session.
localStorage.removeItem('hellodog-admin-auth')
const auth=!localPreview && configUrl && configKey?createClient(configUrl,configKey,{auth:{storageKey:'hellodog-admin-auth',storage:sessionStorage,persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}}):null
let localToken=sessionStorage.getItem('hellodog-admin-local-token')||''
export class ApiError extends Error {constructor(message:string,readonly code:string,readonly uncertain=false){super(message)}}
export const roleNames:Record<Role,string>={owner:'主管理员',admin:'管理员',support:'客服',finance:'财务',editor:'内容运营'}
export const sections=[
  {id:'overview',name:'总览',icon:'◫',hint:'用户与翻译运行概况'},
  {id:'users',name:'用户与余额',icon:'♙',hint:'查找用户、添加字符和管理账号状态'},
  {id:'translations',name:'翻译对账',icon:'⇄',hint:'每个请求的用量、扣费与补偿'},
  {id:'costs',name:'用量与费用',icon:'▥',hint:'实际字符用量、DeepSeek 资金与账单'},
  {id:'account',name:'管理员账号',icon:'♧',hint:'唯一的主管理员与登录密码'},
  {id:'security',name:'安全与保护',icon:'◇',hint:'管理员安全、费用保护和异常记录'},
  {id:'orders',name:'订单',icon:'▤',hint:'人工充值订单及收款记录'},
  {id:'plans',name:'套餐',icon:'◇',hint:'字符额度、价格与启用状态'},
  {id:'versions',name:'版本',icon:'↓',hint:'稳定版与测试版分别管理'},
  {id:'announcements',name:'客户端通知',icon:'◉',hint:'发送弹窗、指定接收用户和查看实际回执'},
  {id:'roles',name:'管理员',icon:'♧',hint:'管理员角色与操作范围'},
  {id:'audit',name:'操作记录',icon:'≡',hint:'每次修改都有据可查'}
]
const grants:Record<Role,string[]>={
  owner:sections.map(s=>s.id),admin:sections.map(s=>s.id),
  support:['overview','users','translations'],finance:['overview','users','translations','orders','plans','audit'],editor:['overview','versions','announcements']
}
export function canView(role:Role,section:string){if(section==='security')return role==='owner';return grants[role].includes(section)||(section==='costs'&&['support','finance'].includes(role))}
export function canWrite(role:Role,scope:'users'|'billing'|'content'|'roles'){
  return role==='owner'||(role==='admin'&&scope!=='roles')||(role==='finance'&&scope==='billing')||(role==='editor'&&scope==='content')
}
async function token(){
  if(localPreview)return localToken
  if(!auth)throw new ApiError('尚未配置管理服务，请使用本地测试入口。','not_configured')
  const {data,error}=await auth.auth.getSession()
  if(error || !data.session)throw new ApiError('请登录管理员账号。','unauthorized')
  return data.session.access_token
}
export async function request<T>(path:string,body?:unknown):Promise<T>{
  const send=async(access:string)=>fetch(`${base}/api/admin/${path}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${access}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,cache:'no-store',signal:AbortSignal.timeout(20000)})
  let response:Response
  try{
    response=await send(await token())
    if(response.status===401 && auth){const refresh=await auth.auth.refreshSession();if(refresh.data.session)response=await send(refresh.data.session.access_token)}
  }catch(error){if(error instanceof ApiError)throw error;throw new ApiError(body?'暂未确认操作结果，请保留原操作并继续查询。':'暂时无法连接，请稍后刷新。','network',Boolean(body))}
  const payload=await response.json().catch(()=>null)
  if(!response.ok){
    if(['mfa_required','mfa_step_up'].includes(payload?.error)) window.dispatchEvent(new CustomEvent('hellodog:admin-mfa',{detail:payload.error}))
    throw new ApiError(String(payload?.message||'管理服务暂时不可用。'),String(payload?.error||'unavailable'),Boolean(body && response.status>=500))
  }
  if(!payload || typeof payload!=='object')throw new ApiError('服务返回结果不完整，请重新查询。','unavailable',Boolean(body))
  return payload as T
}
export const readPage=(kind:string,filters:Record<string,string|number>={})=>request<Page>(kind+'?'+new URLSearchParams(Object.entries(filters).map(([k,v])=>[k,String(v)])))
export async function login(email:string,password:string,role='owner'){
  if(localPreview){
    const response=await fetch('/__local/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role}),signal:AbortSignal.timeout(10000)})
    if(!response.ok)throw new ApiError('本地测试服务尚未启动。','unavailable')
    const data=await response.json();localToken=String(data.token);sessionStorage.setItem('hellodog-admin-local-token',localToken)
  }else{
    if(!auth)throw new ApiError('尚未配置管理员登录服务。','not_configured')
    const {error}=await auth.auth.signInWithPassword({email,password,options:{captchaToken:await authCaptcha()}})
    if(error)throw new ApiError('登录失败，请检查邮箱和密码。','unauthorized')
  }
  // Verify administrator ownership before presenting the MFA enrollment dialog.
  await adminMfaStatus()
  return request<AdminSession>('session')
}
export async function logout(){
  if(localPreview && localToken)await fetch('/__local/logout',{method:'POST',headers:{Authorization:`Bearer ${localToken}`}}).catch(()=>{})
  localToken='';sessionStorage.removeItem('hellodog-admin-local-token');if(auth)await auth.auth.signOut({scope:'local'})
}
export async function changePassword(email:string,currentPassword:string,newPassword:string){
  if(!auth)throw new ApiError('密码设置仅在真实账号模式中使用。','not_configured')
  if(newPassword.length<12)throw new ApiError('新密码至少填写 12 个字符。','invalid_request')
  await request('security-confirm',{})
  const temporary=createClient(configUrl,configKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false,storageKey:'hellodog-admin-reauth'}})
  try{
    const verification=await temporary.auth.signInWithPassword({email,password:currentPassword,options:{captchaToken:await authCaptcha()}})
    if(verification.error)throw new ApiError('当前密码不正确。','unauthorized')
    const current=await auth.auth.getUser()
    if(!current.data.user||verification.data.user.id!==current.data.user.id)throw new ApiError('当前登录账号不一致。','unauthorized')
  }finally{await temporary.auth.signOut({scope:'local'}).catch(()=>{})}
  const {error}=await auth.auth.updateUser({password:newPassword})
  if(error)throw new ApiError('未能修改密码，请检查密码强度后重试。','invalid_request')
}
export const adminMfaStatus=()=>request<{enrolled:boolean;verificationRequired:boolean;recent:boolean}>('security-status')
export async function enrollAdminMfa():Promise<{factorId:string;qr:string;secret:string}>{
  if(localPreview){
    const result=await fetch('/__local/mfa/enroll',{method:'POST',headers:{Authorization:`Bearer ${localToken}`}})
    if(!result.ok)throw new ApiError('测试验证器暂不可用。','unavailable')
    return result.json()
  }
  if(!auth)throw new ApiError('登录服务未配置。','not_configured')
  await adminMfaStatus()
  const factors=await auth.auth.mfa.listFactors()
  if(factors.error)throw new ApiError('暂时无法读取验证器状态。','unavailable')
  if(factors.data.totp.length)throw new ApiError('此账号已有验证器，请直接输入验证码。','mfa_required')
  for(const factor of factors.data.all.filter(f=>f.status==='unverified'&&f.friendly_name==='HelloDog Admin'))await auth.auth.mfa.unenroll({factorId:factor.id})
  const result=await auth.auth.mfa.enroll({factorType:'totp',friendlyName:'HelloDog Admin',issuer:'HelloDog'})
  if(result.error)throw new ApiError('验证器绑定未完成，请稍后重试。','unavailable')
  const qr=result.data.totp.qr_code
  return {factorId:result.data.id,qr:qr.startsWith('data:')?qr:'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(qr),secret:result.data.totp.secret}
}
export async function verifyAdminMfa(code:string,factorId?:string){
  if(!/^\d{6}$/.test(code))throw new ApiError('请输入验证器中的 6 位验证码。','invalid_request')
  if(localPreview){
    const response=await fetch('/__local/mfa/verify',{method:'POST',headers:{Authorization:`Bearer ${localToken}`,'Content-Type':'application/json'},body:JSON.stringify({code})})
    if(!response.ok)throw new ApiError('验证码无效或已过期，请重试。','invalid_request')
    return
  }
  if(!auth)throw new ApiError('登录服务未配置。','not_configured')
  if(!factorId){const factors=await auth.auth.mfa.listFactors();if(factors.error)throw new ApiError('暂时无法读取验证器。','unavailable');factorId=factors.data.totp[0]?.id}
  if(!factorId)throw new ApiError('请先绑定验证器。','mfa_required')
  const result=await auth.auth.mfa.challengeAndVerify({factorId,code})
  if(result.error)throw new ApiError('验证码无效或已过期，请重试。','invalid_request')
}
export function pendingKey(actor:string){return `hellodog-admin-pending:${localPreview?'local':'cloud'}:${actor}`}
export function savePending(actor:string,operation:Operation){localStorage.setItem(pendingKey(actor),JSON.stringify(operation))}
export function clearPending(actor:string){localStorage.removeItem(pendingKey(actor))}
export function loadPending(actor:string):Operation|null{
  try{const raw=localStorage.getItem(pendingKey(actor));return raw?JSON.parse(raw) as Operation:null}catch{return null}
}
export const s=(row:Row,key:string)=>row[key]==null?'':String(row[key])
export const n=(row:Row,key:string)=>Number(row[key]||0)
export const fmt=(v:unknown)=>new Intl.NumberFormat('zh-CN').format(Number(v||0))
export const date=(v:unknown)=>v?new Date(String(v)).toLocaleString('zh-CN',{hour12:false}):'暂无'
export {usd} from './money'
export const tokens=(v:unknown)=>v==null?'未记录':fmt(v)
export const costLabels:Record<string,string>={calculated:'已按实际用量核算',historical_unavailable:'历史用量未记录',missing_usage:'缺少用量回执',missing_cache:'缺少缓存明细',unknown_price:'缺少对应单价',unknown_time:'计费时段待确认',unknown_response:'API 结果未确认',pending:'等待 API 回执',peak:'高峰',off_peak:'空闲',provider:'API 时间',request_window:'请求所在时段',incomplete:'缺少历史明细'}
Object.assign(costLabels,{mixed:'OpenAI + DeepSeek',not_attempted:'未调用翻译服务',unknown_attempt_cost:'部分通道费用待核算',missing_cache_write:'缺少缓存写入回执',unknown_service_tier:'计价档位待确认',default:'标准',fixed:'固定单价'})
export const labels:Record<string,string>={active:'正常',blocked:'已停用',revoked:'已撤销',pending:'待确认',paid:'已入账',cancelled:'已取消',failed:'失败',refunded:'已退款',matched:'账单一致',mismatch:'需要核对',not_charged:'未扣费',cache:'缓存命中',free:'免费处理',processing:'处理中',completed:'已完成',unknown:'结果未知',translation:'翻译扣费',recharge:'充值',adjustment:'人工调整',refund:'翻译补偿',bonus:'赠送',manual:'人工订单',stable:'稳定版',beta:'测试版',info:'一般',warning:'提醒',critical:'重要'}
export const label=(v:unknown)=>costLabels[String(v)]||labels[String(v)]||String(v??'暂无')
export const actionNames:Record<string,string>={'wallet.adjust':'余额调整','translation.refund':'翻译补偿','user.update':'用户设置','user.note':'用户备注','order.create':'创建人工订单','order.settle':'确认收款','order.cancel':'取消订单','plan.save':'保存套餐','version.save':'保存版本','announcement.save':'保存公告','role.set':'管理员权限'}
actionNames['notice.save']='客户端通知'
actionNames['user.clear-content']='清理云端译文'
actionNames['wallet.add']='添加字符';actionNames['cost.reconcile']='官方账单核对'

actionNames['provider.funding.confirm']='确认累计充值与退款'
