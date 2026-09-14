<script setup lang="ts">
import { t, uiLanguage, languageName, uiError } from './lib/uiLocale'

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
let refreshListener: (() => void) | undefined
let refreshTimer: ReturnType<typeof setInterval> | undefined
let currentAuthUser: string | null = null
let authWork: Promise<void> | undefined

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
  currentAuthUser = signingOut ? null : session?.user.id || null
  void sessions.apply(signingOut ? null : session).catch(() => {
    if (!disposed) {
      connectionError.value = t('暂时无法同步登录状态。请检查网络后重试，本地草稿仍保留。')
      loading.value = false
    }
  })
}

async function loadAuth() {
  if (!supabaseConfigured) { loading.value = false; return }
  const client = requireSupabase()
  if (!unsubscribe) {
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      authEvents += 1
      applySession(session)
    })
    unsubscribe = () => data.subscription.unsubscribe()
    // Electron keeps receiving messages while hidden; browser visibility must not stop token rotation.
    void client.auth.startAutoRefresh().catch(() => {})
  }
  const observed = authEvents
  try {
    const { data, error } = await client.auth.getSession()
    if (error) throw error
    if (!disposed && observed === authEvents) {
      currentAuthUser = signingOut ? null : data.session?.user.id || null
      await sessions.apply(signingOut ? null : data.session)
    }
  } catch {
    if (!disposed && observed === authEvents) connectionError.value = t('暂时无法同步登录状态。请检查网络后重试，本地草稿仍保留。')
  } finally { if (!disposed) loading.value = false }
}
function refreshAuth() {
  if (signingOut || disposed) return Promise.resolve()
  return authWork ??= loadAuth().finally(() => { authWork = undefined })
}
async function refreshForRequest(request: { id: string; userId: string }) {
  let ok = false
  try {
    if (disposed || signingOut || currentAuthUser !== request.userId) return
    const { data, error } = await requireSupabase().auth.refreshSession()
    if (error || !data.session || data.session.user.id !== request.userId || disposed || signingOut || currentAuthUser !== request.userId) return
    await sessions.apply(data.session)
    ok = !disposed && !signingOut && currentAuthUser === request.userId
  } finally { await window.desktopAPI.completeAuthRefresh(request.id, ok).catch(() => {}) }
}
const onReconnect = () => { void refreshAuth() }

const onLocalSignOut = () => { authEvents += 1; applySession(null) }
onMounted(() => {
  window.addEventListener('translator:signout', onLocalSignOut)
  window.addEventListener('online', onReconnect); window.addEventListener('focus', onReconnect)
  refreshListener = window.desktopAPI.onAuthRefreshRequested?.((request: { id: string; userId: string }) => { void refreshForRequest(request).catch(() => {}) })
  refreshTimer = setInterval(onReconnect, 30000)
  void refreshAuth()
})
onUnmounted(() => {
  disposed = true; unsubscribe?.(); refreshListener?.(); clearInterval(refreshTimer)
  window.removeEventListener('translator:signout', onLocalSignOut)
  window.removeEventListener('online', onReconnect); window.removeEventListener('focus', onReconnect)
})
</script>

<template>
  <div v-if="loading" class="auth-loading-screen">
    <div class="auth-loading-mark"><img src="/hellodog-icon.webp" alt="HelloDog" /></div>
    <strong>{{ t('正在连接在线账号…') }}</strong>
  </div>
  <App v-else-if="userId" :key="workspaceKey" :user-id="userId" />
  <div v-else-if="connectionError" class="auth-loading-screen"><p>{{ connectionError }}</p><button @click="refreshAuth">{{ t('重试连接') }}</button></div>
  <AuthView v-else @authenticated="applySession" />
</template>
