<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import App from './App.vue'
import AuthView from './components/AuthView.vue'
import { requireSupabase, supabaseConfigured, signingOut } from './lib/supabase'
import { SessionCoordinator, type BridgedSession } from './lib/sessionCoordinator'

const loading = ref(true)
const userId = ref<string | null>(null)
const workspaceKey = ref(0)
const connectionError = ref('')
let unsubscribe: (() => void) | undefined
let disposed = false
let authEvents = 0

const sessions = new SessionCoordinator(async session => {
  await window.desktopAPI.authSetOnlineSession(session ? {
    userId: session.user.id,
    email: session.user.email,
    username: String(session.user.user_metadata?.username || ''),
    accessToken: session.access_token
  } : null)
}, state => {
  if (disposed) return
  userId.value = state.userId
  workspaceKey.value = state.revision
  connectionError.value = ''
  loading.value = false
})

function applySession(session: BridgedSession | null) {
  void sessions.apply(signingOut ? null : session).catch(() => {
    if (!disposed) {
      connectionError.value = '暂时无法同步登录状态。请检查网络后重试，本地草稿仍保留。'
      loading.value = false
    }
  })
}

async function refreshAuth() {
  if (!supabaseConfigured) { loading.value = false; return }
  const client = requireSupabase()
  if (!unsubscribe) {
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      authEvents += 1
      applySession(session)
    })
    unsubscribe = () => data.subscription.unsubscribe()
  }
  const observed = authEvents
  try {
    const { data, error } = await client.auth.getSession()
    if (error) throw error
    if (!disposed && observed === authEvents) await sessions.apply(signingOut ? null : data.session)
  } catch {
    if (!disposed && observed === authEvents) connectionError.value = '暂时无法同步登录状态。请检查网络后重试，本地草稿仍保留。'
  } finally { if (!disposed) loading.value = false }
}

const onLocalSignOut = () => { authEvents += 1; applySession(null) }
onMounted(() => { window.addEventListener('translator:signout', onLocalSignOut); void refreshAuth() })
onUnmounted(() => { disposed = true; unsubscribe?.(); window.removeEventListener('translator:signout', onLocalSignOut) })
</script>

<template>
  <div v-if="loading" class="auth-loading-screen">
    <div class="auth-loading-mark"><img src="/hellodog-icon.webp" alt="HelloDog" /></div>
    <strong>正在连接在线账号…</strong>
  </div>
  <App v-else-if="userId" :key="workspaceKey" :user-id="userId" />
  <div v-else-if="connectionError" class="auth-loading-screen"><p>{{ connectionError }}</p><button @click="refreshAuth">重试连接</button></div>
  <AuthView v-else @authenticated="applySession" />
</template>
