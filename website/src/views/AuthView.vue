<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { requireSupabase, supabaseConfigured } from '../lib/supabase'

const router = useRouter()
const mode = ref<'login'|'register'>('login')
const email = ref('')
const username = ref('')
const password = ref('')
const confirmPassword = ref('')
const busy = ref(false)
const message = ref('')
const error = ref('')

async function submit() {
  busy.value = true
  message.value = ''
  error.value = ''
  try {
    if (!supabaseConfigured) throw new Error('网站尚未配置 Supabase 环境变量。')
    const client = requireSupabase()
    const cleanEmail = email.value.trim().toLowerCase()
    if (!/^\S+@\S+\.\S+$/.test(cleanEmail)) throw new Error('请输入有效邮箱地址。')
    if (password.value.length < 8) throw new Error('密码至少 8 个字符。')

    if (mode.value === 'login') {
      const { error: authError } = await client.auth.signInWithPassword({ email: cleanEmail, password: password.value })
      if (authError) throw authError
      await router.push('/account')
      return
    }

    if (username.value.trim().length < 3) throw new Error('用户名至少 3 个字符。')
    if (password.value !== confirmPassword.value) throw new Error('两次输入的密码不一致。')
    const { data, error: authError } = await client.auth.signUp({
      email: cleanEmail,
      password: password.value,
      options: { data: { username: username.value.trim(), display_name: username.value.trim() } }
    })
    if (authError) throw authError
    if (data.session) await router.push('/account')
    else message.value = '账号已创建，请完成邮箱验证后再登录。'
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main class="auth-page section-grid">
    <section class="auth-pitch">
      <span class="eyebrow">REALTIME TRANSLATOR CLOUD</span>
      <h1>一个账号，连接你的翻译余额与使用记录。</h1>
      <p>桌面端和官网使用同一套 Supabase 在线身份。字符钱包、消费记录和套餐状态都保存在云端。</p>
      <div class="auth-benefits">
        <div><b>统一账号</b><span>Windows 与网页共享身份</span></div>
        <div><b>云端余额</b><span>字符余额不会随重装丢失</span></div>
        <div><b>使用记录</b><span>查看最近翻译消耗</span></div>
      </div>
    </section>

    <section class="auth-card glass-card">
      <div class="auth-tabs">
        <button :class="{ active: mode === 'login' }" @click="mode='login'">登录</button>
        <button :class="{ active: mode === 'register' }" @click="mode='register'">免费注册</button>
      </div>
      <div class="form-stack">
        <label v-if="mode==='register'">用户名<input v-model="username" placeholder="至少 3 个字符" /></label>
        <label>邮箱<input v-model="email" type="email" placeholder="name@example.com" /></label>
        <label>密码<input v-model="password" type="password" placeholder="至少 8 个字符" @keydown.enter="submit" /></label>
        <label v-if="mode==='register'">确认密码<input v-model="confirmPassword" type="password" placeholder="再次输入密码" @keydown.enter="submit" /></label>
        <button class="primary-button full" :disabled="busy" @click="submit">{{ busy ? '处理中…' : mode === 'login' ? '登录账号' : '创建账号' }}</button>
        <p v-if="message" class="form-message success">{{ message }}</p>
        <p v-if="error" class="form-message error">{{ error }}</p>
      </div>
    </section>
  </main>
</template>
