<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { requireSupabase, supabaseConfigured } from '../lib/supabase'

const router = useRouter()
type Mode = 'login' | 'register' | 'verify-signup' | 'recover-request' | 'recover-verify' | 'recover-password' | 'recovered-username'
type RecoveryIntent = 'password' | 'username'

const mode = ref<Mode>('login')
const recoveryIntent = ref<RecoveryIntent>('password')
const email = ref('')
const pendingEmail = ref('')
const username = ref('')
const password = ref('')
const confirmPassword = ref('')
const otp = ref('')
const newPassword = ref('')
const confirmNewPassword = ref('')
const recoveredUsername = ref('')
const busy = ref(false)
const message = ref('')
const error = ref('')

function cleanEmail(value = email.value) {
  return value.trim().toLowerCase()
}

function validateEmail(value: string) {
  if (!/^\S+@\S+\.\S+$/.test(value)) throw new Error('请输入有效邮箱地址。')
}

function clearStatus() {
  message.value = ''
  error.value = ''
}

function go(next: Mode) {
  mode.value = next
  clearStatus()
  otp.value = ''
}

async function login() {
  busy.value = true
  clearStatus()
  try {
    if (!supabaseConfigured) throw new Error('网站尚未配置 Supabase 环境变量。')
    const clean = cleanEmail()
    validateEmail(clean)
    if (password.value.length < 8) throw new Error('请输入正确的密码。')
    const client = requireSupabase()
    const { error: authError } = await client.auth.signInWithPassword({ email: clean, password: password.value })
    if (authError) throw authError
    await router.push('/account')
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    busy.value = false
  }
}

async function register() {
  busy.value = true
  clearStatus()
  try {
    if (!supabaseConfigured) throw new Error('网站尚未配置 Supabase 环境变量。')
    const clean = cleanEmail()
    const cleanUsername = username.value.trim()
    validateEmail(clean)
    if (cleanUsername.length < 3) throw new Error('用户名至少 3 个字符。')
    if (password.value.length < 8) throw new Error('密码至少 8 个字符。')
    if (password.value !== confirmPassword.value) throw new Error('两次输入的密码不一致。')

    const client = requireSupabase()
    const { data, error: authError } = await client.auth.signUp({
      email: clean,
      password: password.value,
      options: { data: { username: cleanUsername, display_name: cleanUsername } }
    })
    if (authError) throw authError

    if (data.session) {
      await router.push('/account')
      return
    }

    pendingEmail.value = clean
    otp.value = ''
    mode.value = 'verify-signup'
    message.value = `验证码已发送至 ${clean}。请输入邮件中的验证码完成邮箱绑定。`
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    busy.value = false
  }
}

async function verifySignup() {
  busy.value = true
  clearStatus()
  try {
    const clean = cleanEmail(pendingEmail.value)
    validateEmail(clean)
    const code = otp.value.trim()
    if (code.length < 6) throw new Error('请输入邮件中的完整验证码。')
    const client = requireSupabase()
    const { data, error: verifyError } = await client.auth.verifyOtp({ email: clean, token: code, type: 'email' })
    if (verifyError) throw verifyError
    if (!data.session) throw new Error('邮箱验证成功，但没有获得登录会话，请重新登录。')
    await router.push('/account')
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    busy.value = false
  }
}

async function resendSignup() {
  busy.value = true
  clearStatus()
  try {
    const clean = cleanEmail(pendingEmail.value)
    validateEmail(clean)
    const client = requireSupabase()
    const { error: resendError } = await client.auth.resend({ type: 'signup', email: clean })
    if (resendError) throw resendError
    message.value = '新的注册验证码已经发送，请查看邮箱。'
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    busy.value = false
  }
}

function startRecovery(intent: RecoveryIntent) {
  recoveryIntent.value = intent
  pendingEmail.value = cleanEmail()
  go('recover-request')
}

async function requestRecovery() {
  busy.value = true
  clearStatus()
  try {
    const clean = cleanEmail(pendingEmail.value || email.value)
    validateEmail(clean)
    const client = requireSupabase()
    const { error: resetError } = await client.auth.resetPasswordForEmail(clean)
    if (resetError) throw resetError
    pendingEmail.value = clean
    otp.value = ''
    mode.value = 'recover-verify'
    message.value = '如果该邮箱已绑定账号，验证码已经发送。请输入邮件中的验证码继续。'
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    busy.value = false
  }
}

async function verifyRecovery() {
  busy.value = true
  clearStatus()
  try {
    const clean = cleanEmail(pendingEmail.value)
    validateEmail(clean)
    const code = otp.value.trim()
    if (code.length < 6) throw new Error('请输入邮件中的完整验证码。')
    const client = requireSupabase()
    const { data, error: verifyError } = await client.auth.verifyOtp({ email: clean, token: code, type: 'recovery' })
    if (verifyError) throw verifyError
    const userId = data.user?.id
    if (!userId) throw new Error('邮箱验证失败，请重新获取验证码。')

    if (recoveryIntent.value === 'password') {
      newPassword.value = ''
      confirmNewPassword.value = ''
      mode.value = 'recover-password'
      message.value = '邮箱验证成功，请设置新密码。'
      return
    }

    const { data: profile, error: profileError } = await client.from('profiles').select('username').eq('id', userId).maybeSingle()
    if (profileError) throw profileError
    recoveredUsername.value = String(profile?.username || data.user?.user_metadata?.username || '未设置用户名')
    await client.auth.signOut()
    mode.value = 'recovered-username'
    message.value = '邮箱验证成功，已找到与该邮箱绑定的账号。'
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    busy.value = false
  }
}

async function resendRecovery() {
  busy.value = true
  clearStatus()
  try {
    const clean = cleanEmail(pendingEmail.value)
    validateEmail(clean)
    const client = requireSupabase()
    const { error: resetError } = await client.auth.resetPasswordForEmail(clean)
    if (resetError) throw resetError
    message.value = '新的账号安全验证码已经发送。'
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    busy.value = false
  }
}

async function updatePassword() {
  busy.value = true
  clearStatus()
  try {
    if (newPassword.value.length < 8) throw new Error('新密码至少 8 个字符。')
    if (newPassword.value !== confirmNewPassword.value) throw new Error('两次输入的新密码不一致。')
    const client = requireSupabase()
    const { error: updateError } = await client.auth.updateUser({ password: newPassword.value })
    if (updateError) throw updateError
    await client.auth.signOut()
    email.value = pendingEmail.value
    password.value = ''
    newPassword.value = ''
    confirmNewPassword.value = ''
    mode.value = 'login'
    message.value = '密码已重置。现在可以使用新密码登录。'
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    busy.value = false
  }
}

function backToLoginWithRecoveredUsername() {
  email.value = pendingEmail.value
  password.value = ''
  mode.value = 'login'
  message.value = `账号用户名：${recoveredUsername.value}。请使用绑定邮箱登录。`
}
</script>

<template>
  <main class="auth-page section-grid">
    <section class="auth-pitch">
      <span class="eyebrow">YOUR HELLODOG ACCOUNT</span>
      <h1>一个账号，连接你的翻译余额与使用记录。</h1>
      <p>官网与客户端共用 HelloDog 账号。验证邮箱后，你可以查看余额、使用记录，也能安全找回账号。</p>
      <div class="auth-benefits">
        <div><b>邮箱绑定</b><span>注册必须完成邮箱验证码确认</span></div>
        <div><b>安全找回</b><span>忘记账号或密码都可以通过绑定邮箱恢复</span></div>
        <div><b>统一账号</b><span>Windows 与网页共享同一身份、余额和记录</span></div>
      </div>
    </section>

    <section class="auth-card glass-card">
      <template v-if="mode === 'login' || mode === 'register'">
        <div class="auth-tabs">
          <button :class="{ active: mode === 'login' }" @click="go('login')">登录</button>
          <button :class="{ active: mode === 'register' }" @click="go('register')">免费注册</button>
        </div>

        <div v-if="mode === 'login'" class="form-stack">
          <label>绑定邮箱<input v-model="email" type="email" placeholder="name@example.com" autocomplete="email" /></label>
          <label>密码<input v-model="password" type="password" placeholder="至少 8 个字符" autocomplete="current-password" @keydown.enter="login" /></label>
          <button class="primary-button full" :disabled="busy" @click="login">{{ busy ? '登录中…' : '登录账号' }}</button>
          <div class="auth-link-row">
            <button type="button" @click="startRecovery('password')">忘记密码？</button>
            <button type="button" @click="startRecovery('username')">忘记账号？</button>
          </div>
        </div>

        <div v-else class="form-stack">
          <label>用户名<input v-model="username" placeholder="至少 3 个字符" autocomplete="username" /></label>
          <label>邮箱<input v-model="email" type="email" placeholder="用于验证码和账号找回" autocomplete="email" /></label>
          <label>密码<input v-model="password" type="password" placeholder="至少 8 个字符" autocomplete="new-password" /></label>
          <label>确认密码<input v-model="confirmPassword" type="password" placeholder="再次输入密码" autocomplete="new-password" @keydown.enter="register" /></label>
          <button class="primary-button full" :disabled="busy" @click="register">{{ busy ? '处理中…' : '注册并发送邮箱验证码' }}</button>
          <p class="auth-helper">验证码验证成功后，邮箱才会正式绑定到该账号。</p>
        </div>
      </template>

      <template v-else-if="mode === 'verify-signup'">
        <div class="auth-code-box">
          <span class="eyebrow">EMAIL VERIFICATION</span>
          <h2>验证注册邮箱</h2>
          <p>验证码已发送至 <b>{{ pendingEmail }}</b>。完成验证后即可使用该账号登录官网与桌面客户端。</p>
        </div>
        <div class="form-stack">
          <label>邮箱验证码<input v-model="otp" class="auth-code-input" inputmode="numeric" maxlength="8" placeholder="请输入邮件中的验证码" @keydown.enter="verifySignup" /></label>
          <button class="primary-button full" :disabled="busy" @click="verifySignup">{{ busy ? '验证中…' : '验证并完成注册' }}</button>
          <div class="auth-link-row">
            <button type="button" :disabled="busy" @click="resendSignup">重新发送验证码</button>
            <button type="button" @click="go('register')">返回修改资料</button>
          </div>
        </div>
      </template>

      <template v-else-if="mode === 'recover-request'">
        <div class="auth-code-box">
          <span class="eyebrow">ACCOUNT RECOVERY</span>
          <h2>{{ recoveryIntent === 'password' ? '重置密码' : '找回账号' }}</h2>
          <p>{{ recoveryIntent === 'password' ? '输入注册时绑定的邮箱，我们会发送账号安全验证码。' : '输入绑定邮箱并完成验证码验证后，才能查看该邮箱绑定的用户名。' }}</p>
        </div>
        <div class="form-stack">
          <label>绑定邮箱<input v-model="pendingEmail" type="email" placeholder="name@example.com" autocomplete="email" @keydown.enter="requestRecovery" /></label>
          <button class="primary-button full" :disabled="busy" @click="requestRecovery">{{ busy ? '发送中…' : '发送邮箱验证码' }}</button>
          <div class="auth-link-row"><button type="button" @click="go('login')">返回登录</button></div>
        </div>
      </template>

      <template v-else-if="mode === 'recover-verify'">
        <div class="auth-code-box">
          <span class="eyebrow">SECURITY CHECK</span>
          <h2>验证绑定邮箱</h2>
          <p>请输入发送至 <b>{{ pendingEmail }}</b> 的账号安全验证码。</p>
        </div>
        <div class="form-stack">
          <label>邮箱验证码<input v-model="otp" class="auth-code-input" inputmode="numeric" maxlength="8" placeholder="请输入验证码" @keydown.enter="verifyRecovery" /></label>
          <button class="primary-button full" :disabled="busy" @click="verifyRecovery">{{ busy ? '验证中…' : '验证邮箱' }}</button>
          <div class="auth-link-row">
            <button type="button" :disabled="busy" @click="resendRecovery">重新发送</button>
            <button type="button" @click="go('recover-request')">更换邮箱</button>
          </div>
        </div>
      </template>

      <template v-else-if="mode === 'recover-password'">
        <div class="auth-code-box">
          <span class="eyebrow">NEW PASSWORD</span>
          <h2>设置新密码</h2>
          <p>邮箱所有权已经确认。设置新密码后，官网和桌面客户端都会立即使用新密码。</p>
        </div>
        <div class="form-stack">
          <label>新密码<input v-model="newPassword" type="password" minlength="8" placeholder="至少 8 个字符" autocomplete="new-password" /></label>
          <label>确认新密码<input v-model="confirmNewPassword" type="password" minlength="8" placeholder="再次输入新密码" autocomplete="new-password" @keydown.enter="updatePassword" /></label>
          <button class="primary-button full" :disabled="busy" @click="updatePassword">{{ busy ? '保存中…' : '确认重置密码' }}</button>
        </div>
      </template>

      <template v-else>
        <div class="auth-code-box recovered-account">
          <span class="eyebrow">ACCOUNT FOUND</span>
          <h2>已找到账号</h2>
          <p>该邮箱绑定的用户名为：</p>
          <strong>{{ recoveredUsername }}</strong>
          <small>为保护账号安全，我们不会显示密码。登录仍使用绑定邮箱 + 密码。</small>
        </div>
        <button class="primary-button full" @click="backToLoginWithRecoveredUsername">返回登录</button>
      </template>

      <p v-if="message" class="form-message success">{{ message }}</p>
      <p v-if="error" class="form-message error">{{ error }}</p>
    </section>
  </main>
</template>
