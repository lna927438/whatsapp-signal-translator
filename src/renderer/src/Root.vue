<script setup lang="ts">
import { t, uiLanguage, languageName, uiError } from './lib/uiLocale'

import { onMounted, onUnmounted, ref, shallowRef } from 'vue'
import App from './App.vue'
import AuthView from './components/AuthView.vue'
import { requireSupabase, createTransientSupabase, supabaseConfigured, signingOut } from './lib/supabase'
import { SessionCoordinator, type BridgedSession } from './lib/sessionCoordinator'
import { inspectDesktopAssurance } from './lib/desktopMfa'
import { boundedAuthWork, requiresSessionLogin } from './lib/sessionRecovery'

const loading = ref(true)
const userId = ref<string | null>(null)
const workspaceKey = ref(0)
const connectionError = ref('')
const mfaSession = shallowRef<BridgedSession | null>(null)
const needsLogin = ref(false)
let observedSession: BridgedSession | null = null
let approvedToken = ''
let rejectedToken = ''
let sessionSequence = 0
let assuranceClient: ReturnType<typeof createTransientSupabase> | undefined
let assuranceCheck: { token: string; work: Promise<'ready' | 'mfa'> } | undefined
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

async function hideWorkspaceForAuth() {
  if (userId.value) await window.desktopAPI.setOverlayOpen(true).catch(() => {})
}
function preserveRevokedWorkspace() {
  if (!userId.value || !observedSession || signingOut || mfaSession.value) return false
  // SDK credential invalidation is different from the user's explicit signout.
  // Keep this owner's draft mounted behind login; a new owner still clears it.
  sessionSequence += 1
  rejectedToken = observedSession.access_token; approvedToken = ''
  needsLogin.value = true; connectionError.value = ''; loading.value = false
  void hideWorkspaceForAuth()
  return true
}
async function applySession(input: BridgedSession | null) {
  const sequence = ++sessionSequence, session = signingOut ? null : input
  observedSession = session
  currentAuthUser = session?.user.id || null
  const current = () => !disposed && sequence === sessionSequence
  try {
    if (userId.value && userId.value !== session?.user.id) {
      // Keep a workspace only while re-authenticating its same owner.
      // Changing owner closes the prior identity before any asynchronous MFA check.
      approvedToken = ''
      await sessions.apply(null)
      if (!current()) return
      loading.value = Boolean(session)
    }
    if (!session) {
      approvedToken = ''; rejectedToken = ''; mfaSession.value = null; needsLogin.value = false
      await sessions.apply(null)
      return
    }
    if (session.access_token === rejectedToken) { needsLogin.value = true; await hideWorkspaceForAuth(); return }
    if (approvedToken !== session.access_token) {
      if (assuranceCheck?.token !== session.access_token) {
        // Inspect through an isolated client: validation of an old token may
        // not clear a newer session in the persistent auth client.
        assuranceClient ||= createTransientSupabase()
        const work = boundedAuthWork(inspectDesktopAssurance(assuranceClient, session))
        const entry = { token: session.access_token, work }; assuranceCheck = entry
        void work.finally(() => { if (assuranceCheck === entry) assuranceCheck = undefined }).catch(() => {})
      }
      const level = await assuranceCheck.work
      if (!current()) return
      if (level === 'mfa') {
        if (mfaSession.value?.access_token !== session.access_token) mfaSession.value = session
        needsLogin.value = false; connectionError.value = ''
        await hideWorkspaceForAuth()
        return
      }
    }
    if (!current()) return
    const interrupted = Boolean(needsLogin.value || mfaSession.value || connectionError.value)
    approvedToken = session.access_token; rejectedToken = ''
    await sessions.apply(session)
    if (!current()) return
    mfaSession.value = null; needsLogin.value = false; connectionError.value = ''
    if (interrupted) await window.desktopAPI.setOverlayOpen(false).catch(() => {})
  } catch (error) {
    if (!current()) return
    if (session && requiresSessionLogin(error)) {
      rejectedToken = session.access_token; needsLogin.value = true; mfaSession.value = null; connectionError.value = ''
    } else connectionError.value = t('暂时无法同步登录状态。请检查网络后重试，本地草稿仍保留。')
    await hideWorkspaceForAuth()
  } finally { if (current()) loading.value = false }
}

async function loadAuth() {
  if (!supabaseConfigured) { loading.value = false; return }
  const client = requireSupabase()
  if (!unsubscribe) {
    const { data } = client.auth.onAuthStateChange((event, session) => {
      authEvents += 1
      if (event === 'SIGNED_OUT' && !session && preserveRevokedWorkspace()) return
      void applySession(session)
    })
    unsubscribe = () => data.subscription.unsubscribe()
    // Electron keeps receiving messages while hidden; browser visibility must not stop token rotation.
    void client.auth.startAutoRefresh().catch(() => {})
  }
  const observed = authEvents
  try {
    const { data, error } = await boundedAuthWork(client.auth.getSession())
    if (error) throw error
    if (!disposed && observed === authEvents) {
      if (!data.session && needsLogin.value && userId.value && !signingOut) return
      await applySession(data.session)
    }
  } catch {
    if (!disposed && observed === authEvents) connectionError.value = t('暂时无法同步登录状态。请检查网络后重试，本地草稿仍保留。')
  } finally { if (!disposed) loading.value = false }
}
function refreshAuth() {
  if (signingOut || disposed) return Promise.resolve()
  return authWork ??= loadAuth().finally(() => { authWork = undefined })
}
async function refreshForRequest(request: { id: string; userId: string; reason?: 'rejected' | 'expiring' }) {
  let ok = false, requiresLogin = false
  const before = observedSession
  try {
    if (disposed || signingOut || currentAuthUser !== request.userId) return
    if (needsLogin.value && before?.access_token === rejectedToken) { requiresLogin = true; return }
    const { data, error } = await boundedAuthWork(requireSupabase().auth.refreshSession())
    if (error) {
      // The SDK intentionally retains unexpired JWTs after refresh failure.
      // A server-rejected session must not stay silently stuck until exp.
      if (request.reason === 'rejected' && requiresSessionLogin(error) && before?.access_token === observedSession?.access_token && currentAuthUser === request.userId) {
        rejectedToken = before!.access_token; needsLogin.value = true; mfaSession.value = null; requiresLogin = true
        await hideWorkspaceForAuth()
      }
      return
    }
    if (!data.session || data.session.user.id !== request.userId || disposed || signingOut || currentAuthUser !== request.userId) return
    await applySession(data.session)
    ok = !disposed && !signingOut && currentAuthUser === request.userId && approvedToken === data.session.access_token && !needsLogin.value && !mfaSession.value
  } finally { await window.desktopAPI.completeAuthRefresh(request.id, ok, requiresLogin).catch(() => {}) }
}
const onReconnect = () => { void refreshAuth() }

const onLocalSignOut = () => { authEvents += 1; void applySession(null) }
onMounted(() => {
  window.addEventListener('translator:signout', onLocalSignOut)
  window.addEventListener('online', onReconnect); window.addEventListener('focus', onReconnect)
  refreshListener = window.desktopAPI.onAuthRefreshRequested?.((request: { id: string; userId: string; reason?: 'rejected' | 'expiring' }) => { void refreshForRequest(request).catch(() => {}) })
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
  <App v-if="userId" :key="workspaceKey" :user-id="userId" />
  <div v-if="loading && !userId" class="auth-loading-screen">
    <div class="auth-loading-mark"><img src="/hellodog-icon.webp" alt="HelloDog" /></div>
    <strong>{{ t('正在连接在线账号…') }}</strong>
  </div>
  <div v-else-if="needsLogin || mfaSession || connectionError" :class="{ 'auth-recovery-layer': userId }">
    <p v-if="needsLogin" class="auth-session-message" role="alert">{{ t('登录会话已失效，请重新登录。草稿与翻译记录已保留。') }}</p>
    <AuthView v-if="needsLogin || mfaSession" :session-to-verify="mfaSession" @authenticated="applySession" @cancelled="mfaSession = null" />
    <div v-else class="auth-loading-screen"><p>{{ connectionError }}</p><button @click="refreshAuth">{{ t('重试连接') }}</button></div>
  </div>
  <AuthView v-else-if="!userId" @authenticated="applySession" />
</template>

<style scoped>
.auth-recovery-layer { position: fixed; inset: 0; z-index: 10000; overflow: auto; background: #10171c; }
.auth-session-message { margin: 0; padding: 16px 24px; color: #ffd8c8; background: #30251f; text-align: center; }
</style>
