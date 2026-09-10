<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { requireSupabase, supabaseConfigured } from './lib/supabase'

const router = useRouter()
const loggedIn = ref(false)
const email = ref('')
const menuOpen = ref(false)
let unsubscribe: (() => void) | undefined
let authRevision = 0

async function syncSession() {
  if (!supabaseConfigured) return
  const revision = authRevision
  const { data } = await requireSupabase().auth.getSession()
  if (revision !== authRevision) return
  loggedIn.value = Boolean(data.session)
  email.value = data.session?.user?.email || ''
}

async function logout() {
  if (!supabaseConfigured) return
  await requireSupabase().auth.signOut({ scope: 'local' })
  loggedIn.value = false
  email.value = ''
  await router.push('/')
}

onMounted(async () => {
  if (supabaseConfigured) {
    const { data } = requireSupabase().auth.onAuthStateChange((_event, session) => {
      authRevision += 1
      loggedIn.value = Boolean(session)
      email.value = session?.user?.email || ''
    })
    unsubscribe = () => data.subscription.unsubscribe()
  }
  await syncSession()
})
onUnmounted(() => unsubscribe?.())
</script>

<template>
  <div class="site-shell">
    <header class="site-header">
      <RouterLink class="brand" to="/">
        <img class="brand-logo" src="/hellodog-icon.webp" alt="HelloDog" />
        <span><b>HelloDog</b><small>让每一句，都被听懂。</small></span>
      </RouterLink>
      <button class="mobile-menu" @click="menuOpen = !menuOpen" :aria-expanded="menuOpen" aria-label="网站导航">☰</button>
      <nav :class="{ open: menuOpen }" @click="menuOpen = false">
        <RouterLink to="/">认识 HelloDog</RouterLink><a href="/#features">功能</a>
        <RouterLink to="/download">下载</RouterLink>
        <RouterLink v-if="loggedIn" to="/account">用户中心</RouterLink>
        <RouterLink v-else to="/login">登录 / 注册</RouterLink>
      </nav>
      <div class="header-actions">
        <span v-if="loggedIn" class="session-email">{{ email }}</span>
        <button v-if="loggedIn" class="ghost-button" @click="logout">退出</button>
        <RouterLink v-else class="primary-button small" to="/download">下载 HelloDog</RouterLink>
      </div>
    </header>

    <RouterView />

    <footer class="site-footer">
      <div><b>HelloDog</b><span>你的跨语言聊天搭档 · WhatsApp + Signal</span></div>
      <div class="footer-links"><RouterLink to="/download">Windows 下载</RouterLink><RouterLink to="/login">账号</RouterLink><span>© 2026</span></div>
    </footer>
  </div>
</template>
