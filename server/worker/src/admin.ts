import { authenticatedClaims, mfaRequired, type AdminIdentity } from './adminSecurity'
import { billingSyncStatus, syncOfficialCosts, BillingSyncError, type BillingSyncEnv } from './billingSync'
type JsonObject = Record<string, unknown>
export interface AdminServices {
  authenticate(token: string): Promise<AdminIdentity>
  rpc(name: 'admin_read' | 'admin_mutate' | 'admin_security_overview', args: JsonObject): Promise<unknown>
  securityEvent?(actor:string,code:string):Promise<void>
  origins: readonly string[]
  providerBalance?():Promise<unknown>
  billingStatus?():unknown
  syncBilling?(range:unknown):Promise<unknown>
}

export const adminErrors: Record<string, [number, string]> = {
  unauthorized: [401, '登录已失效，请重新登录。'],
  billing_not_configured:[503,'尚未连接官方账单读取权限或指定 HelloDog 的账单范围。'],
  billing_permission:[403,'官方账单读取权限不足，请管理员核对账单专用密钥。'],
  billing_data_incomplete:[503,'官方账单数据尚不完整，已保留上次同步结果，请稍后再试。'],
  billing_unavailable:[503,'官方账单暂时无法同步，已保留上次结果。'],
  mfa_required: [403, '请先完成管理员二次验证。'],
  mfa_step_up: [403, '为保护账号，请输入验证器中的验证码，再继续此操作。'],
  rate_limited: [429, '管理请求较多，请稍后重试。'],
  admin_forbidden: [403, '当前账号没有此操作的管理权限。'],
  invalid_request: [400, '请检查填写内容。'],
  not_found: [404, '没有找到这条记录。'],
  operation_conflict: [409, '此操作编号已有不同的内容，请重新核对。'],
  stale_balance: [409, '余额已变化，请刷新用户详情后重新核对调整金额。'],
  stale_note: [409, '备注已在另一处修改。请刷新用户详情，查看最新备注后再保存。'],
  stale_notice: [409, '通知已在另一处修改，请刷新后重新编辑。'],
  invalid_recipient: [400, '没有找到这个登录邮箱，请核对接收用户。'],
  insufficient_available: [409, '可用字符不足，不能扣减正在翻译的预留字符。'],
  already_refunded: [409, '这笔翻译已经补偿，不能重复补偿。'],
  last_owner: [409, '至少需要保留一位正常使用的主管理员。'],
  self_disable: [409, '不能在这里停用自己的账号。'],
  single_owner: [409, '此后台只设置一个主管理员，不能新增或移除。'],
  external_order: [409, '第三方支付订单须通过对应支付渠道处理。'],
  order_final: [409, '订单已经结束，请刷新查看最终结果。'],
  duplicate_reference: [409, '此收款凭证已经使用，请核对订单。'],
  invalid_plan: [400, '请选择已启用且包含字符的套餐。'],
  invalid_release: [400, '启用版本前需填写 HTTPS 下载地址和完整 SHA256 校验值。'],
  unavailable: [503, '管理服务暂时不可用。可刷新查询；未确认的操作请继续查询原编号。']
  ,content_pending:[409,'该用户仍有待确认翻译，请先核对原请求的结算结果，再清理内容。']
}
export class AdminError extends Error { constructor(readonly code: string) { super(code) } }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const kinds = ['session','overview','users','user','translations','costs','orders','plans','versions','announcements','roles','audit','operation']
const object = (value: unknown): value is JsonObject => Boolean(value && typeof value === 'object' && !Array.isArray(value))
function fail(): never { throw new AdminError('invalid_request') }
function string(value: unknown, min: number, max: number) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) fail()
  return value.trim()
}
function integer(value: unknown, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value<min || value>max) fail()
}
function choice(value: unknown, choices: readonly unknown[]) { if (!choices.includes(value)) fail() }

export function validateMutation(body: unknown) {
  if (!object(body) || !object(body.data)) fail()
  const operationId=string(body.operationId,36,36), action=string(body.action,1,40), target=string(body.target,1,160), reason=string(body.reason,3,500)
  if (!uuid.test(operationId)) fail()
  const d=body.data
  const keys:Record<string,string[]>={
    'user.clear-content':[], 'wallet.add':['amount'], 'cost.reconcile':['from','to','officialUsd','officialTokens','officialRequests','reference','timezone'],
    'wallet.adjust':['amount','expectedBalance'], 'translation.refund':[],
    'user.update':['status','plan_code'], 'user.note':['note','expectedRevision'], 'order.create':['plan_code'], 'order.settle':['reference'], 'order.cancel':[],
    'plan.save':['name','characters','price','currency','active'], 'role.set':['role'],
    'version.save':['channel','url','sha256','notes','active'], 'announcement.save':['title','body','level','active','starts_at','ends_at'],
    'notice.save':['title','body','level','active','starts_at','ends_at','popup','audience','recipient','action','expectedRevision']
  }
  if (!keys[action] || Object.keys(d).some(k=>!keys[action].includes(k)) || keys[action].some(k=>!(k in d)&&!(action==='cost.reconcile'&&k==='timezone'))) fail()
  if (!['plan.save','version.save','cost.reconcile'].includes(action) && !uuid.test(target)) fail()
  if ('active' in d && typeof d.active !== 'boolean') fail()
  if ('plan_code' in d && !/^[a-z][a-z0-9_-]{0,39}$/.test(string(d.plan_code,1,40))) fail()
  switch(action) {
    case 'wallet.add': integer(d.amount,1,1000000000);break
    case 'cost.reconcile':
      choice(target,['deepseek','openai']);string(d.reference,3,200)
      if(d.timezone!==undefined)choice(d.timezone,['UTC','Asia/Shanghai'])
      if(!/^-?\d{1,9}(\.\d{1,12})?$/.test(string(d.officialUsd,1,24)))fail()
      for(const k of ['from','to'])if(!/^\d{4}-\d{2}-\d{2}$/.test(string(d[k],10,10))||!Number.isFinite(Date.parse(String(d[k]))))fail()
      if(String(d.to)<String(d.from))fail()
      if(d.officialTokens!==null)integer(d.officialTokens,0,Number.MAX_SAFE_INTEGER);if(d.officialRequests!==null)integer(d.officialRequests,0,1000000000);break
    case 'wallet.adjust': integer(d.amount,-1000000000,1000000000); if(d.amount===0)fail();integer(d.expectedBalance,0,Number.MAX_SAFE_INTEGER);break
    case 'user.update': choice(d.status,['active','blocked']);break
    case 'user.note': string(d.note,0,1000);integer(d.expectedRevision,0,999999999999999);break
    case 'order.settle': string(d.reference,3,120);break
    case 'role.set': choice(d.role,['owner','admin','support','finance','editor','none']);break
    case 'plan.save':
      if(!/^[a-z][a-z0-9_-]{0,39}$/.test(target))fail()
      string(d.name,1,80);integer(d.characters,0,1000000000);integer(d.price,0,100000000)
      if(!/^[A-Z]{3}$/.test(string(d.currency,3,3)))fail();break
    case 'version.save': {
      if(!/^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/.test(target))fail()
      choice(d.channel,['stable','beta']);string(d.notes,0,10000);string(d.url,0,2000);string(d.sha256,0,64)
      if(d.channel==='stable' && /beta|alpha|rc/i.test(target))fail()
      if(d.url) { let url:URL;try{url=new URL(String(d.url))}catch{fail()}
        if(url.protocol!=='https:' || url.username || url.password)fail() }
      if(d.sha256 && !/^[a-f0-9]{64}$/.test(String(d.sha256)))fail()
      if(d.active && (!d.url || !d.sha256))throw new AdminError('invalid_release');break
    }
    case 'notice.save':
      choice(d.popup,[true,false]);choice(d.audience,['all','user']);choice(d.action,['none','website','download']);integer(d.expectedRevision,0,999999999)
      string(d.recipient,0,254);string(d.body,1,3000)
      if(d.audience==='user'&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(d.recipient)))fail()
      if(d.audience==='all'&&d.recipient!=='')fail()
      // The remaining content and schedule checks are shared with legacy announcements.
    case 'announcement.save':
      string(d.title,1,120);string(d.body,1,10000);choice(d.level,['info','warning','critical'])
      if(!Number.isFinite(Date.parse(string(d.starts_at,1,40))))fail()
      string(d.ends_at,0,40)
      if(d.ends_at && (!Number.isFinite(Date.parse(String(d.ends_at))) || Date.parse(String(d.ends_at))<=Date.parse(String(d.starts_at))))fail()
  }
  return {operationId,action,target,reason,data:d}
}

async function boundedJson(request:Request) {
  if(!request.headers.get('content-type')?.startsWith('application/json'))fail()
  const reader=request.body?.getReader();if(!reader)fail()
  const parts:Uint8Array[]=[];let length=0
  try { while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>24576){await reader.cancel();fail()}parts.push(value)} }
  finally {reader.releaseLock()}
  const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length}
  try{return JSON.parse(new TextDecoder().decode(bytes)) as unknown}catch{fail()}
}

export async function handleAdmin(request:Request, services:AdminServices):Promise<Response> {
  const origin=request.headers.get('Origin')
  const headers:Record<string,string>={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Origin',
    'X-Content-Type-Options':'nosniff','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type'}
  if(origin && services.origins.includes(origin))headers['Access-Control-Allow-Origin']=origin
  const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers})
  let authenticatedActor:string|undefined
  try {
    if(origin && !services.origins.includes(origin))throw new AdminError('admin_forbidden')
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers})
    const auth=request.headers.get('Authorization')||''
    if(!/^Bearer \S+$/i.test(auth) || auth.length>8192)throw new AdminError('unauthorized')
    const identity=await services.authenticate(auth.slice(7)), actor=identity.id
    authenticatedActor=actor
    if(!uuid.test(actor))throw new AdminError('unauthorized')
    const url=new URL(request.url), kind=url.pathname.slice('/api/admin/'.length)
    if (kind === 'security-status' && request.method === 'GET') {
      const session = await services.rpc('admin_read', { p_actor: actor, p_kind: 'session', p_filter: {} }) as { role?: string }
      if (session.role !== 'owner') throw new AdminError('admin_forbidden')
      return json({ enrolled: identity.enrolled, verificationRequired: mfaRequired(identity, false), recent: !mfaRequired(identity, true) })
    }
    if (mfaRequired(identity, false)) throw new AdminError('mfa_required')
    if (request.method === 'POST' && mfaRequired(identity, true)) throw new AdminError('mfa_step_up')
    if (kind === 'security-confirm' && request.method === 'POST') {
      await services.rpc('admin_read', { p_actor: actor, p_kind: 'session', p_filter: {} })
      return json({ verified: true })
    }
    if(kind==='security'&&request.method==='GET')return json(await services.rpc('admin_security_overview',{p_actor:actor}))
    if((kind==='billing-status'&&request.method==='GET')||(kind==='billing-sync'&&request.method==='POST')){
      const session=await services.rpc('admin_read',{p_actor:actor,p_kind:'session',p_filter:{}}) as {role?:string}
      if(session.role!=='owner')throw new AdminError('admin_forbidden')
      if(kind==='billing-status')return json(services.billingStatus?.()||{configured:false,message:'尚未连接官方账单同步。'})
      if(!services.syncBilling)throw new AdminError('billing_not_configured')
      return json(await services.syncBilling(await boundedJson(request)))
    }
    if(request.method==='GET' && kind==='provider-balance'){
      const session=await services.rpc('admin_read',{p_actor:actor,p_kind:'session',p_filter:{}}) as {role?:string}
      if(session.role!=='owner')throw new AdminError('admin_forbidden')
      if(!services.providerBalance)throw new AdminError('unavailable')
      return json(await services.providerBalance())
    }
    if(request.method==='GET' && kinds.includes(kind)) {
      const filter:Record<string,string>={}
      for(const [key,value] of url.searchParams){if(!['q','status','offset','userId','operationId','from','to','provider','timezone'].includes(key) || value.length>160)fail();filter[key]=value}
      if(filter.timezone&&!['UTC','Asia/Shanghai'].includes(filter.timezone))fail()
      for(const k of ['from','to'])if(filter[k]&&(!/^\d{4}-\d{2}-\d{2}$/.test(filter[k])||!Number.isFinite(Date.parse(filter[k]))))fail()
      if(filter.provider&&!['deepseek','openai'].includes(filter.provider))fail()
      if(filter.offset && (!/^\d{1,6}$/.test(filter.offset) || Number(filter.offset)>100000))fail()
      if(filter.userId && !uuid.test(filter.userId))fail()
      if(kind==='user' && !filter.userId)fail()
      if(kind==='operation' && !uuid.test(filter.operationId||''))fail()
      return json(await services.rpc('admin_read',{p_actor:actor,p_kind:kind,p_filter:filter}))
    }
    if(request.method==='POST' && kind==='mutate') {
      const b=validateMutation(await boundedJson(request))
      return json(await services.rpc('admin_mutate',{p_actor:actor,p_operation:b.operationId,p_action:b.action,p_target:b.target,p_reason:b.reason,p_data:b.data}))
    }
    return json({error:'not_found',message:'没有找到管理接口。'},404)
  } catch(error) {
    const code=(error instanceof AdminError||error instanceof BillingSyncError) && adminErrors[error.code]?error.code:'unavailable'
    const [status,message]=adminErrors[code]
    if(status===429)headers['Retry-After']='60'
    if(authenticatedActor&&['mfa_required','mfa_step_up','rate_limited'].includes(code))await services.securityEvent?.(authenticatedActor,code).catch(()=>undefined)
    return json({error:code,message},status)
  }
}

export function supabaseAdminServices(env:BillingSyncEnv&{SUPABASE_PUBLISHABLE_KEY:string;DEEPSEEK_API_KEY?:string}):AdminServices {
  return {
    origins:['https://admin.hellodog.net','https://hellodog.net','https://www.hellodog.net'],
    billingStatus(){return billingSyncStatus(env)},
    syncBilling(range){return syncOfficialCosts(env,range)},
    async securityEvent(actor,code){
      await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/record_security_event`,{method:'POST',headers:{apikey:env.SUPABASE_SECRET_KEY,'Content-Type':'application/json'},body:JSON.stringify({p_actor:actor,p_code:code}),signal:AbortSignal.timeout(5000)})
    },
    async providerBalance(){
      if(!env.DEEPSEEK_API_KEY)throw new AdminError('unavailable')
      const response=await fetch('https://api.deepseek.com/user/balance',{headers:{Authorization:`Bearer ${env.DEEPSEEK_API_KEY}`},redirect:'error',signal:AbortSignal.timeout(10000)})
      if(!response.ok)throw new AdminError('unavailable')
      const payload=await response.json() as {is_available?:boolean;balance_infos?:Record<string,unknown>[]}
      const valid=(v:unknown)=>typeof v==='string'&&/^-?\d{1,12}(\.\d{1,12})?$/.test(v)?v:null
      return {provider:'deepseek',available:payload.is_available===true,snapshotAt:new Date().toISOString(),balances:(payload.balance_infos||[]).filter(x=>['USD','CNY'].includes(String(x.currency))).map(x=>({currency:x.currency,total:valid(x.total_balance),granted:valid(x.granted_balance),paid:valid(x.topped_up_balance)}))}
    },
    async authenticate(token){
      const result=await fetch(`${env.SUPABASE_URL}/auth/v1/user`,{headers:{apikey:env.SUPABASE_PUBLISHABLE_KEY,Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(8000)})
      if(result.status===401 || result.status===403)throw new AdminError('unauthorized')
      if(!result.ok)throw new AdminError('unavailable')
      const user=await result.json() as {id?:string; factors?:Array<{status?:string;factor_type?:string}>}
      let identity: AdminIdentity
      try { identity = authenticatedClaims(token, user, env.SUPABASE_URL) } catch { throw new AdminError('unauthorized') }
      const session = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_session_active`, {
        method: 'POST', headers: { apikey: env.SUPABASE_SECRET_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_actor: identity.id, p_session: identity.sessionId }), signal: AbortSignal.timeout(8000)
      })
      if (!session.ok) throw new AdminError('unavailable')
      if (await session.json() !== true) throw new AdminError('unauthorized')
      const rate=await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/security_rate_limit`,{method:'POST',headers:{apikey:env.SUPABASE_SECRET_KEY,'Content-Type':'application/json'},body:JSON.stringify({p_user_id:identity.id,p_scope:'admin'}),signal:AbortSignal.timeout(8000)})
      if(!rate.ok)throw new AdminError('unavailable')
      if(await rate.json()!==true)throw new AdminError('rate_limited')
      return identity
    },
    async rpc(name,args){
      const result=await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`,{method:'POST',headers:{apikey:env.SUPABASE_SECRET_KEY,'Content-Type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(15000)})
      if(!result.ok){
        const error=await result.json().catch(()=>({})) as {message?:string;code?:string}
        if(error.code==='23505')throw new AdminError('duplicate_reference')
        throw new AdminError(error.message && adminErrors[error.message]?error.message:'unavailable')
      }
      return result.json()
    }
  }
}
