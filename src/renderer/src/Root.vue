<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import App from './App.vue'
import AuthView from './components/AuthView.vue'
import { requireSupabase, supabaseConfigured } from './lib/supabase'

const loading = ref(true)
const authenticated = ref(false)
const workspaceKey = ref(0)
let unsubscribe: (() => void) | undefined

async function bridgeSession(session: any) {
  if (!session?.user?.id) {
    await window.desktopAPI.authSetOnlineSession(null)
    authenticated.value = false
    return
  }
  const username = String(session.user.user_metadata?.username || '')
  await window.desktopAPI.authSetOnlineSession({ userId: session.user.id, email: session.user.email, username })
  authenticated.value = true
}

async function refreshAuth() {
  try {
    if (!supabaseConfigured) {
      authenticated.value = false
      return
    }
    const client = requireSupabase()
    const { data, error } = await client.auth.getSession()
    if (error) throw error
    await bridgeSession(data.session)
    const subscription = client.auth.onAuthStateChange((_event, session) => {
      void bridgeSession(session)
      if (session) workspaceKey.value += 1
    })
    unsubscribe = () => subscription.data.subscription.unsubscribe()
  } catch {
    authenticated.value = false
  } finally {
    loading.value = false
  }
}

function onAuthenticated() {
  authenticated.value = true
  workspaceKey.value += 1
}

onMounted(refreshAuth)
onUnmounted(() => unsubscribe?.())
</script>

<template>
  <div v-if="loading" class="auth-loading-screen">
    <div class="auth-loading-mark">译</div>
    <strong>正在连接在线账号…</strong>
  </div>
  <App v-else-if="authenticated" :key="workspaceKey" />
  <AuthView v-else @authenticated="onAuthenticated" />
</template>
