<script setup lang="ts">
import { onMounted, ref } from 'vue'
import App from './App.vue'
import AuthView from './components/AuthView.vue'

const loading = ref(true)
const authenticated = ref(false)
const workspaceKey = ref(0)

async function refreshAuth() {
  try {
    const state = await window.desktopAPI.authStatus()
    authenticated.value = Boolean(state?.authenticated)
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
</script>

<template>
  <div v-if="loading" class="auth-loading-screen">
    <div class="auth-loading-mark">译</div>
    <strong>正在检查登录状态…</strong>
  </div>
  <App v-else-if="authenticated" :key="workspaceKey" />
  <AuthView v-else @authenticated="onAuthenticated" />
</template>
