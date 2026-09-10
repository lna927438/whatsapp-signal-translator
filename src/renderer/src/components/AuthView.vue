<script setup lang="ts">
import { computed, ref } from 'vue'
import { requireSupabase, supabaseConfigured } from '../lib/supabase'

const emit = defineEmits(['authenticated'])
type Mode = 'login' | 'register' | 'reset'
type LoginType = 'username' | 'email'

const mode = ref<Mode>('login')
const loginType = ref<LoginType>('email')
const identifier = ref('')
const username = ref('')
const email = ref('')
const password = ref('')
const confirmPassword = ref('')
const remember = ref(true)
const showPassword = ref(false)
const busy = ref(false)
const error = ref('')
const success = ref('')
const captcha = ref(makeCaptcha())
const captchaInput = ref('')

const title = computed(() => mode.value === 'login' ? '登录' : mode.value === 'register' ? '创建在线账号' : '找回密码')

function makeCaptcha() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  for (let i = 0; i < 4; i += 1) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

function refreshCaptcha() { captcha.value = makeCaptcha(); captchaInput.value = '' }
function switchMode(next: Mode) { mode.value = next; error.value = ''; success.value = ''; password.value = ''; confirmPassword.value = ''; refreshCaptcha() }
function validateCaptcha() {
  if (captchaInput.value.trim().toUpperCase() !== captcha.value) { refreshCaptcha(); throw new Error('验证码不正确，请重新输入。') }
}

async function finishSession(session: any) {
  if (!session?.user?.id || !session?.access_token) throw new Error('没有获得有效登录会话，请重试。')
  await window.desktopAPI.authSetOnlineSession({
    userId: session.user.id,
    email: session.user.email,
    username: String(session.user.user_metadata?.username || ''),
    accessToken: session.access_token
  })
  emit('authenticated', { authenticated: true, source: 'supabase', user: session.user })
}

async function login() {
  busy.value = true; error.value = ''; success.value = ''
  try {
    validateCaptcha()
    if (!supabaseConfigured) throw new Error('在线账号配置尚未注入当前构建，请检查 GitHub Variables 后重新构建。')
    if (loginType.value === 'username') throw new Error('用户名登录将在 Cloudflare API 接入后启用。现在请先使用邮箱登录。')
    const client = requireSupabase()
    const { data, error: authError } = await client.auth.signInWithPassword({ email: identifier.value.trim(), password: password.value })
    if (authError) throw authError
    await finishSession(data.session)
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally { busy.value = false }
}

async function register() {
  busy.value = true; error.value = ''; success.value = ''
  try {
    validateCaptcha()
    if (!supabaseConfigured) throw new Error('在线账号配置尚未注入当前构建，请检查 GitHub Variables 后重新构建。')
    const cleanUsername = username.value.trim()
    const cleanEmail = email.value.trim().toLowerCase()
    if (cleanUsername.length < 3) throw new Error('用户名至少 3 个字符。')
    if (!/^\S+@\S+\.\S+$/.test(cleanEmail)) throw new Error('请输入有效邮箱地址。')
    if (password.value.length < 8) throw new Error('密码至少 8 个字符。')
    if (password.value !== confirmPassword.value) throw new Error('两次输入的密码不一致。')
    const client = requireSupabase()
    const { data, error: authError } = await client.auth.signUp({
      email: cleanEmail,
      password: password.value,
      options: { data: { username: cleanUsername, display_name: cleanUsername } }
    })
    if (authError) throw authError
    if (!data.session) {
      success.value = '账号已创建。当前 Supabase 要求邮箱确认，请先完成邮箱验证后再登录。'
      switchMode('login')
      identifier.value = cleanEmail
      return
    }
    await finishSession(data.session)
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally { busy.value = false }
}

async function resetPassword() {
  busy.value = true; error.value = ''; success.value = ''
  try {
    validateCaptcha()
    if (!supabaseConfigured) throw new Error('在线账号尚未配置。')
    const cleanEmail = identifier.value.trim().toLowerCase()
    if (!/^\S+@\S+\.\S+$/.test(cleanEmail)) throw new Error('找回密码目前需要输入注册邮箱。')
    const client = requireSupabase()
    const { error: resetError } = await client.auth.resetPasswordForEmail(cleanEmail)
    if (resetError) throw resetError
    success.value = '密码重置邮件已发送。正式网站上线后会把重置链接指向我们的账号中心。'
  } catch (e: any) { error.value = e?.message || String(e) }
  finally { busy.value = false }
}
</script>

<template>
  <div class="auth-screen">
    <section class="auth-brand-panel">
      <div class="auth-brand-wordmark"><span>RT</span><b>Realtime Translator</b></div>
      <div class="auth-visual-mark">译</div>
      <div class="auth-brand-copy">
        <h1>WhatsApp + Signal<br />实时精准翻译</h1>
        <p>在线账号、字符钱包和翻译历史正在迁移到云端。登录状态可在当前设备自动恢复。</p>
        <div class="auth-feature-row"><span>Supabase Auth</span><span>云端账号</span><span>本地缓存</span><span>字符计费</span></div>
      </div>
    </section>

    <section class="auth-form-panel">
      <div class="auth-card">
        <div class="auth-card-head">
          <span class="auth-kicker">REALTIME TRANSLATOR CLOUD</span>
          <h2>{{ title }}</h2>
          <p v-if="mode === 'login'">使用在线账号进入 WhatsApp / Signal 翻译工作台</p>
          <p v-else-if="mode === 'register'">账号将创建在新加坡 Supabase 生产项目中</p>
          <p v-else>输入注册邮箱获取密码重置邮件</p>
        </div>

        <template v-if="mode === 'login'">
          <div class="auth-tabs">
            <button :class="{ active: loginType === 'username' }" @click="loginType = 'username'">用户名登录</button>
            <button :class="{ active: loginType === 'email' }" @click="loginType = 'email'">邮箱登录</button>
          </div>
          <p v-if="loginType === 'username'" class="auth-local-note">用户名登录需要我们的 Cloudflare API 做安全解析，下一阶段启用。当前请使用邮箱登录。</p>
          <label class="auth-field"><span>{{ loginType === 'username' ? '用户名' : '邮箱' }}</span><input v-model="identifier" :placeholder="loginType === 'username' ? '暂未启用' : '请输入邮箱地址'" autocomplete="username" @keydown.enter="login" /></label>
          <label class="auth-field"><span>密码</span><div class="auth-password-wrap"><input v-model="password" :type="showPassword ? 'text' : 'password'" placeholder="请输入密码" autocomplete="current-password" @keydown.enter="login" /><button type="button" @click="showPassword = !showPassword">{{ showPassword ? '隐藏' : '显示' }}</button></div></label>
          <div class="auth-captcha-row"><input v-model="captchaInput" maxlength="4" placeholder="请输入验证码" @keydown.enter="login" /><button class="auth-captcha" title="点击刷新验证码" @click="refreshCaptcha">{{ captcha }}</button></div>
          <div class="auth-options">
            <label><input v-model="remember" type="checkbox" />记住登录</label>
            <button @click="switchMode('reset')">忘记密码？</button>
          </div>
          <button class="auth-submit" :disabled="busy || loginType === 'username'" @click="login">{{ busy ? '登录中…' : '登录' }}</button>
          <div class="auth-switch">还没有账号？ <button @click="switchMode('register')">免费注册</button></div>
        </template>

        <template v-else-if="mode === 'register'">
          <label class="auth-field"><span>用户名</span><input v-model="username" placeholder="至少 3 个字符" autocomplete="username" /></label>
          <label class="auth-field"><span>邮箱</span><input v-model="email" type="email" placeholder="请输入邮箱地址" autocomplete="email" /></label>
          <label class="auth-field"><span>密码</span><div class="auth-password-wrap"><input v-model="password" :type="showPassword ? 'text' : 'password'" placeholder="至少 8 个字符" autocomplete="new-password" /><button type="button" @click="showPassword = !showPassword">{{ showPassword ? '隐藏' : '显示' }}</button></div></label>
          <label class="auth-field"><span>确认密码</span><input v-model="confirmPassword" type="password" placeholder="再次输入密码" autocomplete="new-password" /></label>
          <div class="auth-captcha-row"><input v-model="captchaInput" maxlength="4" placeholder="请输入验证码" /><button class="auth-captcha" title="点击刷新验证码" @click="refreshCaptcha">{{ captcha }}</button></div>
          <button class="auth-submit" :disabled="busy" @click="register">{{ busy ? '创建中…' : '创建账号' }}</button>
          <div class="auth-switch">已有账号？ <button @click="switchMode('login')">返回登录</button></div>
        </template>

        <template v-else>
          <label class="auth-field"><span>注册邮箱</span><input v-model="identifier" type="email" placeholder="请输入注册邮箱" autocomplete="email" /></label>
          <div class="auth-captcha-row"><input v-model="captchaInput" maxlength="4" placeholder="请输入验证码" /><button class="auth-captcha" title="点击刷新验证码" @click="refreshCaptcha">{{ captcha }}</button></div>
          <button class="auth-submit" :disabled="busy" @click="resetPassword">{{ busy ? '发送中…' : '发送重置邮件' }}</button>
          <div class="auth-switch"><button @click="switchMode('login')">返回登录</button></div>
        </template>

        <p v-if="error" class="auth-error">{{ error }}</p>
        <p v-if="success" class="auth-success">{{ success }}</p>
      </div>
    </section>
  </div>
</template>
