<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { requireSupabase, supabaseConfigured } from './lib/supabase'

const router = useRouter()
const loggedIn = ref(false)
const email = ref('')

async function syncSession() {
  if (!supabaseConfigured) return
  const { data } = await requireSupabase().auth.getSession()
  loggedIn.value = Boolean(data.session)
  email.value = data.session?.user?.email || ''
}

async function logout() {
  if (!supabaseConfigured) return
  await requireSupabase().auth.signOut()
  loggedIn.value = false
  email.value = ''
  await router.push('/')
}

onMounted(async () => {
  await syncSession()
  if (supabaseConfigured) {
    requireSupabase().auth.onAuthStateChange((_event, session) => {
      loggedIn.value = Boolean(session)
      email.value = session?.user?.email || ''
    })
  }
})
</script>

<template>
  <div class="site-shell">
    <header class="site-header">
      <RouterLink class="brand" to="/">
        <span class="brand-mark">译</span>
        <span><b>Realtime Translator</b><small>WhatsApp + Signal</small></span>
      </RouterLink>
      <nav>
        <RouterLink to="/">首页</RouterLink>
        <RouterLink to="/download">下载</RouterLink>
        <RouterLink v-if="loggedIn" to="/account">用户中心</RouterLink>
        <RouterLink v-else to="/login">登录 / 注册</RouterLink>
      </nav>
      <div class="header-actions">
        <span v-if="loggedIn" class="session-email">{{ email }}</span>
        <button v-if="loggedIn" class="ghost-button" @click="logout">退出</button>
        <RouterLink v-else class="primary-button small" to="/download">免费下载</RouterLink>
      </div>
    </header>

    <RouterView />

    <footer class="site-footer">
      <div><b>Realtime Translator</b><span>WhatsApp + Signal 实时精准翻译</span></div>
      <div class="footer-links"><RouterLink to="/download">Windows 下载</RouterLink><RouterLink to="/login">账号</RouterLink><span>© 2026</span></div>
    </footer>
  </div>
</template>
