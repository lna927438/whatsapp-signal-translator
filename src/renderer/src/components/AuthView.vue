<script setup lang="ts">
import { computed, ref } from 'vue'
import { authStorage, createTransientSupabase, requireSupabase, supabaseConfigured } from '../lib/supabase'

type Mode = 'login' | 'register' | 'verify-signup' | 'recover-request' | 'recover-verify' | 'recover-password' | 'recovered-username'
type RecoveryIntent = 'password' | 'username'

const emit = defineEmits(['authenticated'])
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
const captcha = ref(makeCaptcha())
const captchaInput = ref('')
let recoveryClient: ReturnType<typeof createTransientSupabase> | null = null

const title = computed(() => {
  if (mode.value === 'login') return '登录'
  if (mode.value === 'register') return '创建在线账号'
  if (mode.value === 'verify-signup') return '验证注册邮箱'
  if (mode.value === 'recover-request') return recoveryIntent.value === 'password' ? '重置密码' : '找回账号'
  if (mode.value === 'recover-verify') return '验证绑定邮箱'
  if (mode.value === 'recover-password') return '设置新密码'
  return '已找到账号'
})

function makeCaptcha() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  for (let i = 0; i < 4; i += 1) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

function refreshCaptcha() { captcha.value = makeCaptcha(); captchaInput.value = '' }
function clearStatus() { error.value = ''; success.value = '' }
function cleanEmail(value: string) { return value.trim().toLowerCase() }
function validateEmail(value: string) { if (!/^\S+@\S+\.\S+$/.test(value)) throw new Error('请输入有效邮箱地址。') }
function validateCaptcha() {
  if (captchaInput.value.trim().toUpperCase() !== captcha.value) {
    refreshCaptcha()
    throw new Error('图形验证码不正确，请重新输入。')
  }
}
function go(next: Mode) {
  mode.value = next
  clearStatus()
  otp.value = ''
  if (next === 'login' || next === 'register' || next === 'recover-request') refreshCaptcha()
}

async function finishSession(session: any) {
  if (!session?.user?.id || !session?.access_token) throw new Error('没有获得有效登录会话，请重试。')
  emit('authenticated', session)
}

async function login() {
  if (busy.value) return
  busy.value = true; clearStatus()
  try {
    validateCaptcha()
    if (!supabaseConfigured) throw new Error('在线账号配置尚未注入当前构建，请检查 GitHub Variables 后重新构建。')
    const clean = cleanEmail(identifier.value)
    validateEmail(clean)
    const client = requireSupabase()
    authStorage.setRemember(remember.value)
    const { data, error: authError } = await client.auth.signInWithPassword({ email: clean, password: password.value })
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
    validateCaptcha()
    if (!supabaseConfigured) throw new Error('在线账号配置尚未注入当前构建，请检查 GitHub Variables 后重新构建。')
    const cleanUsername = username.value.trim()
    const clean = cleanEmail(email.value)
    if (cleanUsername.length < 3) throw new Error('用户名至少 3 个字符。')
    validateEmail(clean)
    if (password.value.length < 8) throw new Error('密码至少 8 个字符。')
    if (password.value !== confirmPassword.value) throw new Error('两次输入的密码不一致。')
    const client = requireSupabase()
    authStorage.setRemember(remember.value)
    const { data, error: authError } = await client.auth.signUp({
      email: clean,
      password: password.value,
      options: { data: { username: cleanUsername, display_name: cleanUsername } }
    })
    if (authError) throw authError
    if (data.session) {
      await finishSession(data.session)
      return
    }
    pendingEmail.value = clean
    otp.value = ''
    mode.value = 'verify-signup'
    success.value = `邮箱验证码已发送至 ${clean}。验证成功后邮箱会正式绑定到账号。`
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
    if (code.length < 6) throw new Error('请输入邮件中的完整验证码。')
    const client = requireSupabase()
    const { data, error: verifyError } = await client.auth.verifyOtp({ email: clean, token: code, type: 'email' })
    if (verifyError) throw verifyError
    if (!data.session) throw new Error('邮箱验证成功，但未获得有效登录会话。')
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
    const { error: resendError } = await client.auth.resend({ type: 'signup', email: clean })
    if (resendError) throw resendError
    success.value = '新的注册邮箱验证码已经发送。'
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
    validateCaptcha()
    if (!supabaseConfigured) throw new Error('在线账号尚未配置。')
    const clean = cleanEmail(pendingEmail.value)
    validateEmail(clean)
    recoveryClient = createTransientSupabase()
    const { error: resetError } = await recoveryClient.auth.resetPasswordForEmail(clean)
    if (resetError) throw resetError
    pendingEmail.value = clean
    otp.value = ''
    mode.value = 'recover-verify'
    success.value = '如果该邮箱已绑定账号，账号安全验证码已经发送。'
  } catch (e: any) { error.value = e?.message || String(e) }
  finally { busy.value = false }
}

async function verifyRecovery() {
  busy.value = true; clearStatus()
  try {
    const clean = cleanEmail(pendingEmail.value)
    validateEmail(clean)
    const code = otp.value.trim()
    if (code.length < 6) throw new Error('请输入邮件中的完整验证码。')
    recoveryClient ||= createTransientSupabase()
    const { data, error: verifyError } = await recoveryClient.auth.verifyOtp({ email: clean, token: code, type: 'recovery' })
    if (verifyError) throw verifyError
    const userId = data.user?.id
    if (!userId) throw new Error('邮箱验证失败，请重新获取验证码。')

    if (recoveryIntent.value === 'password') {
      newPassword.value = ''
      confirmNewPassword.value = ''
      mode.value = 'recover-password'
      success.value = '邮箱验证成功，请设置新的登录密码。'
      return
    }

    const { data: profile, error: profileError } = await recoveryClient.from('profiles').select('username').eq('id', userId).maybeSingle()
    if (profileError) throw profileError
    recoveredUsername.value = String(profile?.username || data.user?.user_metadata?.username || '未设置用户名')
    await recoveryClient.auth.signOut()
    recoveryClient = null
    mode.value = 'recovered-username'
    success.value = '邮箱验证成功，已找到绑定账号。'
  } catch (e: any) { error.value = e?.message || String(e) }
  finally { busy.value = false }
}

async function resendRecovery() {
  busy.value = true; clearStatus()
  try {
    const clean = cleanEmail(pendingEmail.value)
    validateEmail(clean)
    recoveryClient = createTransientSupabase()
    const { error: resetError } = await recoveryClient.auth.resetPasswordForEmail(clean)
    if (resetError) throw resetError
    success.value = '新的账号安全验证码已经发送。'
  } catch (e: any) { error.value = e?.message || String(e) }
  finally { busy.value = false }
}

async function updatePassword() {
  busy.value = true; clearStatus()
  try {
    if (!recoveryClient) throw new Error('密码恢复会话已失效，请重新获取验证码。')
    if (newPassword.value.length < 8) throw new Error('新密码至少 8 个字符。')
    if (newPassword.value !== confirmNewPassword.value) throw new Error('两次输入的新密码不一致。')
    const { error: updateError } = await recoveryClient.auth.updateUser({ password: newPassword.value })
    if (updateError) throw updateError
    await recoveryClient.auth.signOut()
    recoveryClient = null
    identifier.value = pendingEmail.value
    password.value = ''
    mode.value = 'login'
    refreshCaptcha()
    success.value = '密码已重置。现在可以使用新密码登录。'
  } catch (e: any) { error.value = e?.message || String(e) }
  finally { busy.value = false }
}

function backToLoginWithRecoveredUsername() {
  identifier.value = pendingEmail.value
  password.value = ''
  mode.value = 'login'
  refreshCaptcha()
  error.value = ''
  success.value = `账号用户名：${recoveredUsername.value}。请使用绑定邮箱登录。`
}
</script>

<template>
  <div class="auth-screen">
    <section class="auth-brand-panel">
      <div class="auth-brand-wordmark"><img src="/hellodog-icon.webp" alt="" /><b>HelloDog</b></div>
      <div class="auth-visual-mark"><img src="/hellodog-icon.webp" alt="HelloDog 小狗" /></div>
      <div class="auth-brand-copy">
        <h1>熟悉的语言。<br />更广阔的世界。</h1>
        <p>连接 WhatsApp 与 Signal，让翻译融入每一次对话。用 HelloDog，轻松说 Hello。</p>
        <div class="auth-feature-row"><span>邮箱验证</span><span>云端账号</span><span>安全找回</span><span>字符钱包</span></div>
      </div>
    </section>

    <section class="auth-form-panel">
      <div class="auth-card">
        <div class="auth-card-head">
          <span class="auth-kicker">SAY HELLO, GO FURTHER.</span>
          <h2>{{ title }}</h2>
          <p v-if="mode === 'login'">使用在线账号进入 WhatsApp / Signal 翻译工作台</p>
          <p v-else-if="mode === 'register'">创建账号并通过邮箱验证码完成绑定</p>
          <p v-else-if="mode === 'verify-signup'">输入注册邮箱收到的验证码</p>
          <p v-else-if="mode === 'recover-request'">通过绑定邮箱验证账号所有权</p>
          <p v-else-if="mode === 'recover-verify'">输入邮件中的账号安全验证码</p>
          <p v-else-if="mode === 'recover-password'">邮箱已验证，请设置新密码</p>
          <p v-else>邮箱已验证，已找到绑定账号</p>
        </div>

        <template v-if="mode === 'login'">
          <label class="auth-field"><span>绑定邮箱</span><input v-model="identifier" type="email" placeholder="请输入绑定邮箱" autocomplete="username" @keydown.enter="login" /></label>
          <label class="auth-field"><span>密码</span><div class="auth-password-wrap"><input v-model="password" :type="showPassword ? 'text' : 'password'" placeholder="请输入密码" autocomplete="current-password" @keydown.enter="login" /><button type="button" @click="showPassword = !showPassword">{{ showPassword ? '隐藏' : '显示' }}</button></div></label>
          <div class="auth-captcha-row"><input v-model="captchaInput" maxlength="4" placeholder="请输入图形验证码" @keydown.enter="login" /><button class="auth-captcha" title="点击刷新验证码" @click="refreshCaptcha">{{ captcha }}</button></div>
          <div class="auth-options">
            <label><input v-model="remember" type="checkbox" />记住登录</label>
            <div class="auth-recovery-links"><button @click="startRecovery('password')">忘记密码？</button><button @click="startRecovery('username')">忘记账号？</button></div>
          </div>
          <button class="auth-submit" :disabled="busy" @click="login">{{ busy ? '登录中…' : '登录' }}</button>
          <div class="auth-switch">还没有账号？ <button @click="go('register')">免费注册</button></div>
        </template>

        <template v-else-if="mode === 'register'">
          <label class="auth-field"><span>用户名</span><input v-model="username" placeholder="至少 3 个字符" autocomplete="username" /></label>
          <label class="auth-field"><span>邮箱</span><input v-model="email" type="email" placeholder="用于验证码和账号找回" autocomplete="email" /></label>
          <label class="auth-field"><span>密码</span><div class="auth-password-wrap"><input v-model="password" :type="showPassword ? 'text' : 'password'" placeholder="至少 8 个字符" autocomplete="new-password" /><button type="button" @click="showPassword = !showPassword">{{ showPassword ? '隐藏' : '显示' }}</button></div></label>
          <label class="auth-field"><span>确认密码</span><input v-model="confirmPassword" type="password" placeholder="再次输入密码" autocomplete="new-password" /></label>
          <div class="auth-captcha-row"><input v-model="captchaInput" maxlength="4" placeholder="请输入图形验证码" /><button class="auth-captcha" title="点击刷新验证码" @click="refreshCaptcha">{{ captcha }}</button></div>
          <button class="auth-submit" :disabled="busy" @click="register">{{ busy ? '创建中…' : '注册并发送邮箱验证码' }}</button>
          <div class="auth-switch">已有账号？ <button @click="go('login')">返回登录</button></div>
        </template>

        <template v-else-if="mode === 'verify-signup'">
          <div class="auth-otp-intro"><b>{{ pendingEmail }}</b><span>验证码验证成功后，该邮箱将正式绑定到账号。</span></div>
          <label class="auth-field"><span>邮箱验证码</span><input v-model="otp" class="auth-otp-input" inputmode="numeric" maxlength="8" placeholder="请输入邮件验证码" @keydown.enter="verifySignup" /></label>
          <button class="auth-submit" :disabled="busy" @click="verifySignup">{{ busy ? '验证中…' : '验证并完成注册' }}</button>
          <div class="auth-switch auth-switch-split"><button :disabled="busy" @click="resendSignup">重新发送</button><button @click="go('register')">返回修改资料</button></div>
        </template>

        <template v-else-if="mode === 'recover-request'">
          <div class="auth-otp-intro"><b>{{ recoveryIntent === 'password' ? '重置密码' : '找回账号' }}</b><span>{{ recoveryIntent === 'password' ? '输入注册时绑定的邮箱，我们会发送账号安全验证码。' : '只有完成邮箱验证码验证后，才会显示绑定的用户名。' }}</span></div>
          <label class="auth-field"><span>绑定邮箱</span><input v-model="pendingEmail" type="email" placeholder="请输入注册邮箱" autocomplete="email" /></label>
          <div class="auth-captcha-row"><input v-model="captchaInput" maxlength="4" placeholder="请输入图形验证码" /><button class="auth-captcha" title="点击刷新验证码" @click="refreshCaptcha">{{ captcha }}</button></div>
          <button class="auth-submit" :disabled="busy" @click="requestRecovery">{{ busy ? '发送中…' : '发送邮箱验证码' }}</button>
          <div class="auth-switch"><button @click="go('login')">返回登录</button></div>
        </template>

        <template v-else-if="mode === 'recover-verify'">
          <div class="auth-otp-intro"><b>{{ pendingEmail }}</b><span>请输入邮件中的账号安全验证码。</span></div>
          <label class="auth-field"><span>邮箱验证码</span><input v-model="otp" class="auth-otp-input" inputmode="numeric" maxlength="8" placeholder="请输入验证码" @keydown.enter="verifyRecovery" /></label>
          <button class="auth-submit" :disabled="busy" @click="verifyRecovery">{{ busy ? '验证中…' : '验证邮箱' }}</button>
          <div class="auth-switch auth-switch-split"><button :disabled="busy" @click="resendRecovery">重新发送</button><button @click="go('recover-request')">更换邮箱</button></div>
        </template>

        <template v-else-if="mode === 'recover-password'">
          <label class="auth-field"><span>新密码</span><div class="auth-password-wrap"><input v-model="newPassword" :type="showPassword ? 'text' : 'password'" placeholder="至少 8 个字符" autocomplete="new-password" /><button type="button" @click="showPassword = !showPassword">{{ showPassword ? '隐藏' : '显示' }}</button></div></label>
          <label class="auth-field"><span>确认新密码</span><input v-model="confirmNewPassword" type="password" placeholder="再次输入新密码" autocomplete="new-password" @keydown.enter="updatePassword" /></label>
          <button class="auth-submit" :disabled="busy" @click="updatePassword">{{ busy ? '保存中…' : '确认重置密码' }}</button>
        </template>

        <template v-else>
          <div class="recovery-result"><small>该邮箱绑定的用户名</small><strong>{{ recoveredUsername }}</strong><p>账号密码不会通过邮件显示。如忘记密码，可返回后使用“忘记密码”流程重置。</p></div>
          <button class="auth-submit" @click="backToLoginWithRecoveredUsername">返回登录</button>
        </template>

        <p v-if="error" class="auth-error">{{ error }}</p>
        <p v-if="success" class="auth-success">{{ success }}</p>
      </div>
    </section>
  </div>
</template>
