<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { downloadBase } from '../lib/supabase'

const loading = ref(true)
const metadata = ref<any>(null)
const error = ref('')

const latestUrl = computed(() => {
  const key = metadata.value?.latestKey || 'windows/latest/WhatsApp-Signal-Translator-Setup.exe'
  return `${downloadBase}/${key}`
})
const versionUrl = computed(() => {
  const key = metadata.value?.versionKey
  return key ? `${downloadBase}/${key}` : latestUrl.value
})
const version = computed(() => metadata.value?.version || '最新版')
const sizeLabel = computed(() => {
  const size = Number(metadata.value?.size || 0)
  if (!size) return '—'
  return `${(size / 1024 / 1024).toFixed(1)} MB`
})

async function loadMetadata() {
  try {
    const response = await fetch(`${downloadBase}/metadata/version.json`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`版本信息读取失败 (${response.status})`)
    metadata.value = await response.json()
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    loading.value = false
  }
}

onMounted(loadMetadata)
</script>

<template>
  <main class="download-page">
    <section class="download-hero section-grid">
      <div>
        <span class="eyebrow">WINDOWS DOWNLOAD</span>
        <h1>下载 Realtime Translator</h1>
        <p>Windows 桌面版，支持 WhatsApp 与 Signal。安装包通过 Cloudflare R2 分发。</p>
        <div class="hero-actions">
          <a class="primary-button" :href="latestUrl">下载最新版</a>
          <a class="ghost-button" :href="versionUrl">下载 {{ version }}</a>
        </div>
        <p v-if="error" class="form-message error">{{ error }}</p>
      </div>
      <div class="download-card glass-card">
        <div class="download-icon">↧</div>
        <div><span>当前版本</span><strong>{{ loading ? '读取中…' : version }}</strong></div>
        <div class="download-meta"><span>平台 <b>Windows x64</b></span><span>大小 <b>{{ sizeLabel }}</b></span><span>分发 <b>Cloudflare R2</b></span></div>
      </div>
    </section>

    <section class="install-steps">
      <div class="section-heading"><span class="eyebrow">GET STARTED</span><h2>三步开始使用</h2></div>
      <div class="steps-grid">
        <article><span>1</span><h3>下载安装</h3><p>下载 Setup.exe，根据安装向导完成安装。</p></article>
        <article><span>2</span><h3>登录账号</h3><p>使用官网或客户端创建的 Supabase 在线账号登录。</p></article>
        <article><span>3</span><h3>添加 WhatsApp / Signal</h3><p>选择账号，设置双方语言，即可开始实时翻译。</p></article>
      </div>
    </section>

    <section class="release-info glass-card">
      <div><span class="eyebrow">RELEASE</span><h2>{{ version }}</h2></div>
      <div class="release-grid">
        <span>发布时间<b>{{ metadata?.releasedAt ? new Date(metadata.releasedAt).toLocaleString('zh-CN', { hour12: false }) : '—' }}</b></span>
        <span>SHA256<b class="mono">{{ metadata?.sha256 ? metadata.sha256.slice(0, 18) + '…' : '—' }}</b></span>
        <span>下载源<b>Cloudflare R2</b></span>
      </div>
    </section>
  </main>
</template>
