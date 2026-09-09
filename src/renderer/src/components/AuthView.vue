<script setup lang="ts">
import { computed, ref } from 'vue'

const emit = defineEmits(['authenticated'])
type Mode = 'login' | 'register' | 'reset'
type LoginType = 'username' | 'email'

const mode = ref<Mode>('login')
const loginType = ref<LoginType>('username')
const identifier = ref('')
const username = ref('')
const email = ref('')
const password = ref('')
const confirmPassword = ref('')
const recoveryCode = ref('')
const remember = ref(true)
const showPassword = ref(false)
const busy = ref(false)
const error = ref('')
const success = ref('')
const newRecoveryCode = ref('')
const captcha = ref(makeCaptcha())
const captchaInput = ref('')

const title = computed(() => mode.value === 'login' ? '登录' : mode.value === 'register' ? '创建账号' : '重置密码')

function makeCaptcha() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  for (let i = 0; i < 4; i += 1) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

function refreshCaptcha() {
  captcha.value = makeCaptcha()
  captchaInput.value = ''
}

function switchMode(next: Mode) {
  mode.value = next
  error.value = ''
  success.value = ''
  password.value = ''
  confirmPassword.value = ''
  recoveryCode.value = ''
  newRecoveryCode.value = ''
  refreshCaptcha()
}

function validateCaptcha() {
  if (captchaInput.value.trim().toUpperCase() !== captcha.value) {
    refreshCaptcha()
    throw new Error('验证码不正确，请重新输入。')
  }
}

async function login() {
  busy.value = true
  error.value = ''
  try {
    validateCaptcha()
    const state = await window.desktopAPI.authLogin({
      identifier: identifier.value,
      password: password.value,
      remember: remember.value
    })
    emit('authenticated', state)
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    busy.value = false
  }
}

async function register() {
  busy.value = true
  error.value = ''
  try {
    validateCaptcha()
    if (password.value !== confirmPassword.value) throw new Error('两次输入的密码不一致。')
    const result = await window.desktopAPI.authRegister({
      username: username.value,
      email: email.value,
      password: password.value,
      remember: true
    })
    newRecoveryCode.value = String(result?.recoveryCode || '')
    success.value = '账号已创建。请保存下面的恢复码，它只用于本机忘记密码时重置密码。'
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    busy.value = false
  }
}

async function resetPassword() {
  busy.value = true
  error.value = ''
  try {
    validateCaptcha()
    if (password.value !== confirmPassword.value) throw new Error('两次输入的新密码不一致。')
    await window.desktopAPI.authResetPassword({
      identifier: identifier.value,
      recoveryCode: recoveryCode.value,
      newPassword: password.value
    })
    success.value = '密码已经重置，请使用新密码登录。'
    password.value = ''
    confirmPassword.value = ''
    recoveryCode.value = ''
    setTimeout(() => switchMode('login'), 1200)
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    busy.value = false
  }
}

function enterAfterRegister() {
  emit('authenticated', { authenticated: true })
}
</script>

<template>
  <div class="auth-screen">
    <section class="auth-brand-panel">
      <div class="auth-brand-wordmark"><span>RT</span><b>Realtime Translator</b></div>
      <div class="auth-visual-mark">译</div>
      <div class="auth-brand-copy">
        <h1>WhatsApp + Signal<br />实时精准翻译</h1>
        <p>跨语言沟通，不改变原意。历史译文优先从本地缓存恢复，不重复消耗字符额度。</p>
        <div class="auth-feature-row"><span>精准翻译</span><span>多账号</span><span>本地缓存</span><span>字符计费</span></div>
      </div>
    </section>

    <section class="auth-form-panel">
      <div class="auth-card">
        <div class="auth-card-head">
          <span class="auth-kicker">REALTIME TRANSLATOR</span>
          <h2>{{ title }}</h2>
          <p v-if="mode === 'login'">登录后进入 WhatsApp / Signal 翻译工作台</p>
          <p v-else-if="mode === 'register'">首次使用只需在当前电脑创建一个本地账号</p>
          <p v-else>使用注册时生成的恢复码重置本机密码</p>
        </div>

        <template v-if="newRecoveryCode">
          <div class="recovery-result">
            <small>一次性显示 · 请立即保存</small>
            <strong>{{ newRecoveryCode }}</strong>
            <p>{{ success }}</p>
          </div>
          <button class="auth-submit" @click="enterAfterRegister">我已保存恢复码，进入软件</button>
        </template>

        <template v-else-if="mode === 'login'">
          <div class="auth-tabs">
            <button :class="{ active: loginType === 'username' }" @click="loginType = 'username'">用户名登录</button>
            <button :class="{ active: loginType === 'email' }" @click="loginType = 'email'">邮箱登录</button>
          </div>

          <label class="auth-field">
            <span>{{ loginType === 'username' ? '用户名' : '邮箱' }}</span>
            <input v-model="identifier" :placeholder="loginType === 'username' ? '请输入用户名' : '请输入邮箱地址'" autocomplete="username" @keydown.enter="login" />
          </label>
          <label class="auth-field">
            <span>密码</span>
            <div class="auth-password-wrap">
              <input v-model="password" :type="showPassword ? 'text' : 'password'" placeholder="请输入密码" autocomplete="current-password" @keydown.enter="login" />
              <button type="button" @click="showPassword = !showPassword">{{ showPassword ? '隐藏' : '显示' }}</button>
            </div>
          </label>
          <div class="auth-captcha-row">
            <input v-model="captchaInput" maxlength="4" placeholder="请输入验证码" @keydown.enter="login" />
            <button class="auth-captcha" title="点击刷新验证码" @click="refreshCaptcha">{{ captcha }}</button>
          </div>
          <div class="auth-options">
            <label><input v-model="remember" type="checkbox" /> 保持登录</label>
            <button @click="switchMode('reset')">忘记密码？</button>
          </div>
          <button class="auth-submit" :disabled="busy" @click="login">{{ busy ? '登录中…' : '登录' }}</button>
          <div class="auth-switch">还没有账号？<button @click="switchMode('register')">免费注册</button></div>
        </template>

        <template v-else-if="mode === 'register'">
          <label class="auth-field"><span>用户名</span><input v-model="username" placeholder="3–40 个字符" autocomplete="username" /></label>
          <label class="auth-field"><span>邮箱</span><input v-model="email" type="email" placeholder="用于账号识别" autocomplete="email" /></label>
          <label class="auth-field"><span>密码</span><input v-model="password" :type="showPassword ? 'text' : 'password'" placeholder="至少 8 个字符" autocomplete="new-password" /></label>
          <label class="auth-field"><span>确认密码</span><input v-model="confirmPassword" :type="showPassword ? 'text' : 'password'" placeholder="再次输入密码" autocomplete="new-password" /></label>
          <div class="auth-captcha-row"><input v-model="captchaInput" maxlength="4" placeholder="请输入验证码" /><button class="auth-captcha" @click="refreshCaptcha">{{ captcha }}</button></div>
          <button class="auth-submit" :disabled="busy" @click="register">{{ busy ? '创建中…' : '注册并登录' }}</button>
          <div class="auth-switch">已经有账号？<button @click="switchMode('login')">返回登录</button></div>
        </template>

        <template v-else>
          <label class="auth-field"><span>用户名或邮箱</span><input v-model="identifier" placeholder="请输入用户名或邮箱" /></label>
          <label class="auth-field"><span>恢复码</span><input v-model="recoveryCode" placeholder="注册时保存的恢复码" autocapitalize="characters" /></label>
          <label class="auth-field"><span>新密码</span><input v-model="password" :type="showPassword ? 'text' : 'password'" placeholder="至少 8 个字符" /></label>
          <label class="auth-field"><span>确认新密码</span><input v-model="confirmPassword" :type="showPassword ? 'text' : 'password'" placeholder="再次输入新密码" /></label>
          <div class="auth-captcha-row"><input v-model="captchaInput" maxlength="4" placeholder="请输入验证码" /><button class="auth-captcha" @click="refreshCaptcha">{{ captcha }}</button></div>
          <button class="auth-submit" :disabled="busy" @click="resetPassword">{{ busy ? '处理中…' : '重置密码' }}</button>
          <div class="auth-switch"><button @click="switchMode('login')">返回登录</button></div>
        </template>

        <p v-if="error" class="auth-error">{{ error }}</p>
        <p v-else-if="success && !newRecoveryCode" class="auth-success">{{ success }}</p>
        <p class="auth-local-note">当前版本为本机账号系统：密码使用 scrypt 哈希保存，不在源码中保存明文密码。正式多设备版本将迁移到服务端账号系统。</p>
      </div>
    </section>
  </div>
</template>
