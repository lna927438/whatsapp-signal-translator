<script setup lang="ts">
async function authCaptcha():Promise<string|undefined>{return import.meta.env.VITE_AUTH_CAPTCHA_ENABLED==='true'?window.desktopAPI.authCaptchaToken():undefined}
import { t, uiLanguage, languageName, uiError } from '../lib/uiLocale'
import UiLanguagePicker from './UiLanguagePicker.vue'

import { computed, ref, shallowRef, watch, onBeforeUnmount } from 'vue'
import { authStorage, createTransientSupabase, requireSupabase, supabaseConfigured } from '../lib/supabase'
import { inspectDesktopAssurance, confirmDesktopMfa, verifiedTotpFactors, type DesktopTotpFactor } from '../lib/desktopMfa'
import type { BridgedSession } from '../lib/sessionCoordinator'
import { boundedAuthWork, requiresSessionLogin } from '../lib/sessionRecovery'

type Mode = 'login' | 'register' | 'verify-signup' | 'verify-mfa' | 'recover-request' | 'recover-verify' | 'recover-password' | 'recovered-username'
type RecoveryIntent = 'password' | 'username'

const props = defineProps<{ sessionToVerify?: BridgedSession | null }>()
const emit = defineEmits<{ authenticated: [session: BridgedSession]; cancelled: [] }>()
const mode = ref<Mode>('login')
const recoveryIntent = ref<RecoveryIntent>('password')
const identifier = ref('')
const username = ref('')
const email = ref('')
const pendingEmail = ref('')
const password = ref('')
const confirmPassword = ref('')
const otp = ref('')
const newPassword = ref('')
const confirmNewPassword = ref('')
const recoveredUsername = ref('')
const remember = ref(true)
const showPassword = ref(false)
const busy = ref(false)
const error = ref('')
const success = ref('')
const mfaSession = shallowRef<BridgedSession | null>(null)
const mfaFactors = ref<DesktopTotpFactor[]>([])
const mfaFactorId = ref('')
let mfaClient: ReturnType<typeof requireSupabase> | null = null
let mfaContinuation: (() => Promise<void>) | null = null
let mfaRevision = 0
let disposed = false


let recoveryClient: ReturnType<typeof createTransientSupabase> | null = null

const title = computed(() => {
  if (mode.value === 'login') return t('登录')
  if (mode.value === 'register') return t('创建在线账号')
  if (mode.value === 'verify-signup') return t('验证注册邮箱')
  if (mode.value === 'verify-mfa') return t('安全验证')
  if (mode.value === 'recover-request') return recoveryIntent.value === 'password' ? t('重置密码') : t('找回账号')
  if (mode.value === 'recover-verify') return t('验证绑定邮箱')
  if (mode.value === 'recover-password') return t('设置新密码')
  return t('已找到账号')
})



function clearStatus() { error.value = ''; success.value = '' }
function authFailure(error: any): string {
  if (requiresSessionLogin(error)) return t('登录会话已失效，请重新登录。草稿与翻译记录已保留。')
  if (error?.code === 'mfa_verification_failed' || error?.message === 'Invalid TOTP code entered') return t('验证码不正确，请输入验证器中当前的六位验证码。')
  return error?.message || String(error)
}
function cleanEmail(value: string) { return value.trim().toLowerCase() }
function validateEmail(value: string) { if (!/^\S+@\S+\.\S+$/.test(value)) throw new Error(t('请输入有效邮箱地址。')) }

function go(next: Mode) {
  mode.value = next
  clearStatus()
  otp.value = ''
}

async function finishSession(session: any) {
  if (!session?.user?.id || !session?.access_token) throw new Error(t('没有获得有效登录会话，请重试。'))
  const client = requireSupabase()
  const revision = mfaRevision
  const assurance = await boundedAuthWork(inspectDesktopAssurance(client, session))
  if (disposed || revision !== mfaRevision) return
  if (assurance === 'mfa') {
    await beginMfa(client, session)
    return
  }
  if (disposed) return
  emit('authenticated', session)
}

async function beginMfa(client: ReturnType<typeof requireSupabase>, session: BridgedSession, continuation: (() => Promise<void>) | null = null) {
  const revision = ++mfaRevision
  mfaClient = client; mfaSession.value = session; mfaContinuation = continuation
  mode.value = 'verify-mfa'; otp.value = ''; mfaFactors.value = []; mfaFactorId.value = ''
  busy.value = true; clearStatus(); password.value = ''
  try {
    const { data, error: factorError } = await boundedAuthWork(client.auth.mfa.listFactors())
    if (factorError) throw factorError
    if (disposed || revision !== mfaRevision) return
    mfaFactors.value = verifiedTotpFactors(data)
    mfaFactorId.value = mfaFactors.value[0]?.id || ''
    if (!mfaFactorId.value) throw new Error(t('此账号没有可用的验证器，请使用原有登录方式完成安全验证。'))
  } catch (e: any) { if (!disposed && revision === mfaRevision) error.value = authFailure(e) }
  finally { if (!disposed && revision === mfaRevision) busy.value = false }
}

async function retryMfa() {
  if (!busy.value && mfaClient && mfaSession.value) await beginMfa(mfaClient, mfaSession.value, mfaContinuation)
}

async function verifyMfa() {
  if (busy.value || !mfaClient || !mfaSession.value) return
  const client = mfaClient, pending = mfaSession.value, continuation = mfaContinuation, revision = mfaRevision
  const active = () => !disposed && revision === mfaRevision
  busy.value = true; clearStatus()
  try {
    const code = otp.value.trim()
    if (!/^\d{6}$/.test(code)) throw new Error(t('请输入验证器中的六位验证码。'))
    if (!mfaFactors.value.some(factor => factor.id === mfaFactorId.value)) throw new Error(t('请重新加载账号安全验证。'))
    const before = await boundedAuthWork(client.auth.getSession())
    if (before.error) throw before.error
    if (!active()) return
    if (before.data.session?.user.id !== pending.user.id) throw new Error(t('登录账号已变化，请重新登录。'))
    const { error: verifyError } = await boundedAuthWork(client.auth.mfa.challengeAndVerify({ factorId: mfaFactorId.value, code }))
    if (verifyError) throw verifyError
    if (!active()) return
    const { data, error: sessionError } = await boundedAuthWork(client.auth.getSession())
    if (sessionError) throw sessionError
    if (!data.session || data.session.user.id !== pending.user.id) throw new Error(t('登录账号已变化，请重新登录。'))
    await boundedAuthWork(confirmDesktopMfa(client, data.session))
    if (!active()) return
    otp.value = ''; mfaSession.value = null; mfaContinuation = null
    if (continuation) await continuation()
    else emit('authenticated', data.session)
  } catch (e: any) { if (active()) error.value = authFailure(e) }
  finally { if (active()) busy.value = false }
}

async function cancelMfa() {
  if (busy.value) return
  const client = mfaClient, pending = mfaSession.value
  const revision = ++mfaRevision
  const active = () => !disposed && revision === mfaRevision
  busy.value = true; clearStatus(); otp.value = ''
  try {
    const current = client ? await boundedAuthWork(client.auth.getSession()) : null
    if (current?.error) throw current.error
    if (!active()) return
    if (current?.data.session && current.data.session.access_token !== pending?.access_token) throw new Error(t('登录状态已更新，请重新验证。'))
    // Never sign out a different account that became active during verification.
    if (client && current?.data.session?.user.id === pending?.user.id) {
      const { error: logoutError } = await boundedAuthWork(client.auth.signOut({ scope: 'local' }))
      if (logoutError) throw logoutError
    }
    if (!active()) return
    mfaSession.value = null; mfaClient = null; mfaContinuation = null; recoveryClient = null
    mode.value = 'login'; emit('cancelled')
  } catch (e: any) { if (active()) error.value = authFailure(e) }
  finally { if (active()) busy.value = false }
}

watch(() => props.sessionToVerify, session => {
  if (session && session.access_token !== mfaSession.value?.access_token) void beginMfa(requireSupabase(), session)
  else if (!session && mfaSession.value && !mfaContinuation) {
    ++mfaRevision; mfaSession.value = null; mfaClient = null; busy.value = false; go('login')
  }
}, { immediate: true })
onBeforeUnmount(() => { disposed = true; ++mfaRevision; otp.value = ''; password.value = '' })

async function login() {
  if (busy.value) return
  busy.value = true; clearStatus()
  try {
    if (!supabaseConfigured) throw new Error(t('在线账号配置尚未注入当前构建，请检查 GitHub Variables 后重新构建。'))
    const clean = cleanEmail(identifier.value)
    validateEmail(clean)
    const client = requireSupabase()
    authStorage.setRemember(remember.value)
    const { data, error: authError } = await client.auth.signInWithPassword({ email: clean, password: password.value, options: { captchaToken: await authCaptcha() } })
    if (authError) throw authError
    await finishSession(data.session)
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally { busy.value = false }
}

async function register() {
  if (busy.value) return
  busy.value = true; clearStatus()
  try {
    if (!supabaseConfigured) throw new Error(t('在线账号配置尚未注入当前构建，请检查 GitHub Variables 后重新构建。'))
    const cleanUsername = username.value.trim()
    const clean = cleanEmail(email.value)
    if (cleanUsername.length < 3) throw new Error(t('用户名至少 3 个字符。'))
    validateEmail(clean)
    if (password.value.length < 12) throw new Error(t('密码至少 12 个字符。'))
    if (password.value !== confirmPassword.value) throw new Error(t('两次输入的密码不一致。'))
    const client = requireSupabase()
    authStorage.setRemember(remember.value)
    const { data, error: authError } = await client.auth.signUp({
      email: clean,
      password: password.value,
      options: { captchaToken: await authCaptcha(), data: { username: cleanUsername, display_name: cleanUsername } }
    })
    if (authError) throw authError
    if (data.session) {
      await finishSession(data.session)
      return
    }
    pendingEmail.value = clean
    otp.value = ''
    mode.value = 'verify-signup'
    success.value = t('邮箱验证码已发送至 {0}。验证成功后邮箱会正式绑定到账号。', clean)
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally { busy.value = false }
}

async function verifySignup() {
  busy.value = true; clearStatus()
  try {
    const clean = cleanEmail(pendingEmail.value)
    validateEmail(clean)
    const code = otp.value.trim()
    if (code.length < 6) throw new Error(t('请输入邮件中的完整验证码。'))
    const client = requireSupabase()
    const { data, error: verifyError } = await client.auth.verifyOtp({ email: clean, token: code, type: 'email' })
    if (verifyError) throw verifyError
    if (!data.session) throw new Error(t('邮箱验证成功，但未获得有效登录会话。'))
    await finishSession(data.session)
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally { busy.value = false }
}

async function resendSignup() {
  busy.value = true; clearStatus()
  try {
    const clean = cleanEmail(pendingEmail.value)
    validateEmail(clean)
    const client = requireSupabase()
    const { error: resendError } = await client.auth.resend({ type: 'signup', email: clean, options: { captchaToken: await authCaptcha() } })
    if (resendError) throw resendError
    success.value = t('新的注册邮箱验证码已经发送。')
  } catch (e: any) { error.value = e?.message || String(e) }
  finally { busy.value = false }
}

function startRecovery(intent: RecoveryIntent) {
  recoveryIntent.value = intent
  pendingEmail.value = cleanEmail(identifier.value)
  recoveryClient = null
  go('recover-request')
}

async function requestRecovery() {
  busy.value = true; clearStatus()
  try {
    if (!supabaseConfigured) throw new Error(t('在线账号尚未配置。'))
    const clean = cleanEmail(pendingEmail.value)
    validateEmail(clean)
    recoveryClient = createTransientSupabase()
    const { error: resetError } = await recoveryClient.auth.resetPasswordForEmail(clean, { captchaToken: await authCaptcha() })
    if (resetError) throw resetError
    pendingEmail.value = clean
    otp.value = ''
    mode.value = 'recover-verify'
    success.value = t('如果该邮箱已绑定账号，账号安全验证码已经发送。')
  } catch (e: any) { error.value = e?.message || String(e) }
  finally { busy.value = false }
}

async function verifyRecovery() {
  busy.value = true; clearStatus()
  try {
    const clean = cleanEmail(pendingEmail.value)
    validateEmail(clean)
    const code = otp.value.trim()
    if (code.length < 6) throw new Error(t('请输入邮件中的完整验证码。'))
    recoveryClient ||= createTransientSupabase()
    const { data, error: verifyError } = await recoveryClient.auth.verifyOtp({ email: clean, token: code, type: 'recovery' })
    if (verifyError) throw verifyError
    const userId = data.user?.id
    if (!userId) throw new Error(t('邮箱验证失败，请重新获取验证码。'))
    if (!data.session) throw new Error(t('没有获得有效登录会话，请重试。'))
    if (await inspectDesktopAssurance(recoveryClient, data.session) === 'mfa') {
      await beginMfa(recoveryClient, data.session, () => completeRecovery(userId, data.user?.user_metadata?.username))
      return
    }
    await completeRecovery(userId, data.user?.user_metadata?.username)
  } catch (e: any) { error.value = e?.message || String(e) }
  finally { busy.value = false }
}

async function completeRecovery(userId: string, fallbackUsername?: unknown) {
    if (!recoveryClient || disposed) return
    if (recoveryIntent.value === 'password') {
      newPassword.value = ''
      confirmNewPassword.value = ''
      mode.value = 'recover-password'
      success.value = t('邮箱验证成功，请设置新的登录密码。')
      return
    }

    const { data: profile, error: profileError } = await recoveryClient.from('profiles').select('username').eq('id', userId).maybeSingle()
    if (profileError) throw profileError
    recoveredUsername.value = String(profile?.username || fallbackUsername || t('未设置用户名'))
    await recoveryClient.auth.signOut({ scope: 'local' })
    recoveryClient = null
    mode.value = 'recovered-username'
    success.value = t('邮箱验证成功，已找到绑定账号。')
}

async function resendRecovery() {
  busy.value = true; clearStatus()
  try {
    const clean = cleanEmail(pendingEmail.value)
    validateEmail(clean)
    recoveryClient = createTransientSupabase()
    const { error: resetError } = await recoveryClient.auth.resetPasswordForEmail(clean, { captchaToken: await authCaptcha() })
    if (resetError) throw resetError
    success.value = t('新的账号安全验证码已经发送。')
  } catch (e: any) { error.value = e?.message || String(e) }
  finally { busy.value = false }
}

async function updatePassword() {
  busy.value = true; clearStatus()
  try {
    if (!recoveryClient) throw new Error(t('密码恢复会话已失效，请重新获取验证码。'))
    if (newPassword.value.length < 12) throw new Error(t('新密码至少 12 个字符。'))
    if (newPassword.value !== confirmNewPassword.value) throw new Error(t('两次输入的新密码不一致。'))
    const { error: updateError } = await recoveryClient.auth.updateUser({ password: newPassword.value })
    if (updateError) throw updateError
    await recoveryClient.auth.signOut()
    recoveryClient = null
    identifier.value = pendingEmail.value
    password.value = ''
    mode.value = 'login'
    success.value = t('密码已重置。现在可以使用新密码登录。')
  } catch (e: any) { error.value = e?.message || String(e) }
  finally { busy.value = false }
}

function backToLoginWithRecoveredUsername() {
  identifier.value = pendingEmail.value
  password.value = ''
  mode.value = 'login'
  error.value = ''
  success.value = t('账号用户名：{0}。请使用绑定邮箱登录。', recoveredUsername.value)
}
</script>

<template>
  <div class="auth-screen" :class="{ 'auth-mfa-screen': mode === 'verify-mfa' }">
    <section class="auth-brand-panel">
      <div class="auth-brand-wordmark"><img src="/hellodog-icon.webp" alt="" /><b>HelloDog</b></div>
      <div class="auth-visual-mark"><img src="/hellodog-icon.webp" :alt="t('HelloDog 小狗')" /></div>
      <div class="auth-brand-copy">
        <h1>{{ t('熟悉的语言。') }}<br />{{ t('更广阔的世界。') }}</h1>
        <p>{{ t('连接 WhatsApp 与 Signal，让翻译融入每一次对话。用 HelloDog，轻松说 Hello。') }}</p>
        <div class="auth-feature-row"><span>{{ t('邮箱验证') }}</span><span>{{ t('云端账号') }}</span><span>{{ t('安全找回') }}</span><span>{{ t('字符钱包') }}</span></div>
      </div>
    </section>

    <section class="auth-form-panel">
      <div class="auth-card">
        <UiLanguagePicker class="auth-language" />
        <div class="auth-card-head">
          <span class="auth-kicker">SAY HELLO, GO FURTHER.</span>
          <h2>{{ title }}</h2>
          <p v-if="mode === 'login'">{{ t('使用在线账号进入 WhatsApp / Signal 翻译工作台') }}</p>
          <p v-else-if="mode === 'register'">{{ t('创建账号并通过邮箱验证码完成绑定') }}</p>
          <p v-else-if="mode === 'verify-signup'">{{ t('输入注册邮箱收到的验证码') }}</p>
          <p v-else-if="mode === 'verify-mfa'">{{ t('此账号已开启安全验证，请输入验证器中的验证码。') }}</p>
          <p v-else-if="mode === 'recover-request'">{{ t('通过绑定邮箱验证账号所有权') }}</p>
          <p v-else-if="mode === 'recover-verify'">{{ t('输入邮件中的账号安全验证码') }}</p>
          <p v-else-if="mode === 'recover-password'">{{ t('邮箱已验证，请设置新密码') }}</p>
          <p v-else>{{ t('邮箱已验证，已找到绑定账号') }}</p>
        </div>

        <template v-if="mode === 'login'">
          <label class="auth-field"><span>{{ t('绑定邮箱') }}</span><input v-model="identifier" type="email" :placeholder="t('请输入绑定邮箱')" autocomplete="username" @keydown.enter="login" /></label>
          <label class="auth-field"><span>{{ t('密码') }}</span><div class="auth-password-wrap"><input v-model="password" :type="showPassword ? 'text' : 'password'" :placeholder="t('请输入密码')" autocomplete="current-password" @keydown.enter="login" /><button type="button" @click="showPassword = !showPassword">{{ showPassword ? t('隐藏') : t('显示') }}</button></div></label>
          <div class="auth-options">
            <label><input v-model="remember" type="checkbox" />{{ t('记住登录') }}</label>
            <div class="auth-recovery-links"><button @click="startRecovery('password')">{{ t('忘记密码？') }}</button><button @click="startRecovery('username')">{{ t('忘记账号？') }}</button></div>
          </div>
          <button class="auth-submit" :disabled="busy" @click="login">{{ busy ? t('登录中…') : t('登录') }}</button>
          <div class="auth-switch">{{ t('还没有账号？ ') }}<button @click="go('register')">{{ t('免费注册') }}</button></div>
        </template>

        <template v-else-if="mode === 'verify-mfa'">
          <div class="auth-otp-intro"><b>{{ mfaSession?.user.email }}</b><span>{{ t('完成验证后继续使用，已有草稿和聊天会保留。') }}</span></div>
          <label v-if="mfaFactors.length > 1" class="auth-field"><span>{{ t('验证器') }}</span><select v-model="mfaFactorId" :disabled="busy"><option v-for="(factor, index) in mfaFactors" :key="factor.id" :value="factor.id">{{ factor.friendly_name || t('验证器 {0}', index + 1) }}</option></select></label>
          <label class="auth-field"><span>{{ t('验证器验证码') }}</span><input v-model="otp" class="auth-otp-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" :disabled="busy || !mfaFactorId" :placeholder="t('请输入六位验证码')" @keydown.enter="verifyMfa" /></label>
          <button class="auth-submit" :disabled="busy || !mfaFactorId" @click="verifyMfa">{{ busy ? t('验证中…') : t('验证并继续') }}</button>
          <div class="auth-switch auth-switch-split"><button v-if="!mfaFactorId" :disabled="busy" @click="retryMfa">{{ t('重新加载') }}</button><button :disabled="busy" @click="cancelMfa">{{ t('返回登录') }}</button></div>
        </template>

        <template v-else-if="mode === 'register'">
          <label class="auth-field"><span>{{ t('用户名') }}</span><input v-model="username" :placeholder="t('至少 3 个字符')" autocomplete="username" /></label>
          <label class="auth-field"><span>{{ t('邮箱') }}</span><input v-model="email" type="email" :placeholder="t('用于验证码和账号找回')" autocomplete="email" /></label>
          <label class="auth-field"><span>{{ t('密码') }}</span><div class="auth-password-wrap"><input v-model="password" :type="showPassword ? 'text' : 'password'" :placeholder="t('至少 12 个字符')" autocomplete="new-password" /><button type="button" @click="showPassword = !showPassword">{{ showPassword ? t('隐藏') : t('显示') }}</button></div></label>
          <label class="auth-field"><span>{{ t('确认密码') }}</span><input v-model="confirmPassword" type="password" :placeholder="t('再次输入密码')" autocomplete="new-password" /></label>
          <button class="auth-submit" :disabled="busy" @click="register">{{ busy ? t('创建中…') : t('注册并发送邮箱验证码') }}</button>
          <div class="auth-switch">{{ t('已有账号？ ') }}<button @click="go('login')">{{ t('返回登录') }}</button></div>
        </template>

        <template v-else-if="mode === 'verify-signup'">
          <div class="auth-otp-intro"><b>{{ pendingEmail }}</b><span>{{ t('验证码验证成功后，该邮箱将正式绑定到账号。') }}</span></div>
          <label class="auth-field"><span>{{ t('邮箱验证码') }}</span><input v-model="otp" class="auth-otp-input" inputmode="numeric" maxlength="8" :placeholder="t('请输入邮件验证码')" @keydown.enter="verifySignup" /></label>
          <button class="auth-submit" :disabled="busy" @click="verifySignup">{{ busy ? t('验证中…') : t('验证并完成注册') }}</button>
          <div class="auth-switch auth-switch-split"><button :disabled="busy" @click="resendSignup">{{ t('重新发送') }}</button><button @click="go('register')">{{ t('返回修改资料') }}</button></div>
        </template>

        <template v-else-if="mode === 'recover-request'">
          <div class="auth-otp-intro"><b>{{ recoveryIntent === 'password' ? t('重置密码') : t('找回账号') }}</b><span>{{ recoveryIntent === 'password' ? t('输入注册时绑定的邮箱，我们会发送账号安全验证码。') : t('只有完成邮箱验证码验证后，才会显示绑定的用户名。') }}</span></div>
          <label class="auth-field"><span>{{ t('绑定邮箱') }}</span><input v-model="pendingEmail" type="email" :placeholder="t('请输入注册邮箱')" autocomplete="email" /></label>
          <button class="auth-submit" :disabled="busy" @click="requestRecovery">{{ busy ? t('发送中…') : t('发送邮箱验证码') }}</button>
          <div class="auth-switch"><button @click="go('login')">{{ t('返回登录') }}</button></div>
        </template>

        <template v-else-if="mode === 'recover-verify'">
          <div class="auth-otp-intro"><b>{{ pendingEmail }}</b><span>{{ t('请输入邮件中的账号安全验证码。') }}</span></div>
          <label class="auth-field"><span>{{ t('邮箱验证码') }}</span><input v-model="otp" class="auth-otp-input" inputmode="numeric" maxlength="8" :placeholder="t('请输入验证码')" @keydown.enter="verifyRecovery" /></label>
          <button class="auth-submit" :disabled="busy" @click="verifyRecovery">{{ busy ? t('验证中…') : t('验证邮箱') }}</button>
          <div class="auth-switch auth-switch-split"><button :disabled="busy" @click="resendRecovery">{{ t('重新发送') }}</button><button @click="go('recover-request')">{{ t('更换邮箱') }}</button></div>
        </template>

        <template v-else-if="mode === 'recover-password'">
          <label class="auth-field"><span>{{ t('新密码') }}</span><div class="auth-password-wrap"><input v-model="newPassword" :type="showPassword ? 'text' : 'password'" :placeholder="t('至少 12 个字符')" autocomplete="new-password" /><button type="button" @click="showPassword = !showPassword">{{ showPassword ? t('隐藏') : t('显示') }}</button></div></label>
          <label class="auth-field"><span>{{ t('确认新密码') }}</span><input v-model="confirmNewPassword" type="password" :placeholder="t('再次输入新密码')" autocomplete="new-password" @keydown.enter="updatePassword" /></label>
          <button class="auth-submit" :disabled="busy" @click="updatePassword">{{ busy ? t('保存中…') : t('确认重置密码') }}</button>
        </template>

        <template v-else>
          <div class="recovery-result"><small>{{ t('该邮箱绑定的用户名') }}</small><strong>{{ recoveredUsername }}</strong><p>{{ t('账号密码不会通过邮件显示。如忘记密码，可返回后使用“忘记密码”流程重置。') }}</p></div>
          <button class="auth-submit" @click="backToLoginWithRecoveredUsername">{{ t('返回登录') }}</button>
        </template>

        <p v-if="error" class="auth-error">{{ uiError(error) }}</p>
        <p v-if="success" class="auth-success">{{ success }}</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.auth-field select { width: 100%; min-height: 43px; padding: 0 12px; border: 1px solid #dbe2ed; border-radius: 8px; background: #fbfcfe; color: #15233a; }
@media (max-width: 1000px) {
  .auth-mfa-screen { grid-template-columns: minmax(0, 1fr); }
  .auth-mfa-screen .auth-brand-panel { display: none; }
}
</style>
