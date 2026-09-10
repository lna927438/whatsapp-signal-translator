<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { downloadBase } from '../lib/supabase'
const loading = ref(true)
const metadata = ref<any>(null)
const error = ref('')
const copied = ref('')
const latestUrl = computed(() => `${downloadBase}/windows/latest/WhatsApp-Signal-Translator-Setup.exe`)
const versionUrl = computed(() => metadata.value?.versionKey ? `${downloadBase}/${metadata.value.versionKey}` : latestUrl.value)
const version = computed(() => metadata.value?.version || '最新版')
const sizeLabel = computed(() => metadata.value?.size ? `${(metadata.value.size / 1024 / 1024).toFixed(1)} MiB` : '待获取')
async function loadMetadata() {
  if (!loading.value) loading.value = true
  error.value = ''
  try {
    const response = await fetch(`${downloadBase}/metadata/version.json`, { cache: 'no-store', signal: AbortSignal.timeout(12000) })
    if (!response.ok) throw new Error(`版本信息读取失败 (${response.status})`)
    const value = await response.json()
    if (!/^windows\/v[\d.]+\/[\w.\-]+\.exe$/.test(value.versionKey) || !/^[a-f0-9]{64}$/i.test(value.sha256) || !Number.isFinite(value.size) || value.size <= 0) throw new Error('版本信息暂不可用，请稍后刷新。')
    metadata.value = value
  } catch (e: any) { error.value = e?.name === 'TimeoutError' ? '获取版本信息超时。你可以重试，或使用下方固定下载入口。' : e?.message || '暂时无法读取版本信息。' }
  finally { loading.value = false }
}
async function copy(value: string, kind: string) {
  try { await navigator.clipboard.writeText(value); copied.value = kind + '已复制' }
  catch { copied.value = '复制未成功，请手动选择下方内容。' }
}
onMounted(loadMetadata)
</script>
<template>
  <main class="download-page hello-download">
    <section class="download-hero section-grid"><div><span class="eyebrow">YOUR NEXT CONVERSATION STARTS HERE.</span><h1>HelloDog，<br />准备好说 Hello。</h1><p>把翻译带进你的 WhatsApp 与 Signal。<br />下载 Windows 桌面版，连接账号，开始交流。</p><div class="hero-actions"><a class="primary-button" :href="versionUrl">下载 HelloDog <span>↓</span></a><button class="ghost-button" :disabled="loading" @click="loadMetadata">{{ loading ? '查询版本中…' : '刷新版本' }}</button></div><p class="download-platform">Windows x64 · 需要网络连接</p><p v-if="error" class="form-message error" role="alert">{{ error }}</p></div><div class="download-card glass-card"><div class="download-product"><img src="/hellodog-icon.webp" alt="HelloDog 图标" /><div><b>HelloDog</b><small>你的跨语言聊天搭档</small></div><span class="download-badge">WINDOWS</span></div><div class="download-current"><span>当前可下载版本</span><strong>{{ loading ? '读取中…' : metadata?.version ? 'v' + version.replace(/^v/, '') : '暂未获取' }}</strong></div><div class="download-meta"><span>平台<b>Windows x64</b></span><span>安装包大小<b>{{ sizeLabel }}</b></span><span>安装方式<b>安装向导</b></span></div><a class="text-link" :href="latestUrl">固定下载入口 →</a><small class="delivery-note">固定入口与上方链接使用同一下载源。</small></div></section>
    <section class="download-help"><div><span class="eyebrow">SLOW NETWORK? TAKE IT EASY.</span><h2>网速慢，也可以慢慢来。</h2><p>优先使用上方版本下载链接。中断时，在浏览器下载列表中选择继续；支持续传的下载工具也可使用同一链接。</p><button class="ghost-button" @click="copy(versionUrl, '下载链接')">复制下载链接</button><p class="copy-feedback" aria-live="polite">{{ copied }}</p></div><div class="download-faq"><details open><summary>安装新版本，原来的账号还在吗？</summary><p>直接运行安装程序完成升级。HelloDog 沿用旧版的数据目录，保留已有账号、登录资料与本地草稿。升级前请先关闭正在运行的客户端。</p></details><details><summary>官网下载后，如何开始使用？</summary><p>登录 HelloDog，先在「设置与连接」检查线路，再添加 WhatsApp 或 Signal 并完成设备关联，最后设置双方语言。</p></details><details><summary>显示“翻译服务凭据无效”怎么办？</summary><p>这是服务端配置问题。管理员需要更新翻译服务凭据，重复下载客户端不能解决。失败的翻译不会扣减字符。</p></details></div></section>
    <section class="install-steps"><div class="section-heading"><span class="eyebrow">THREE SMALL STEPS.</span><h2>装好，然后自在聊。</h2></div><div class="steps-grid"><article><span>01</span><h3>下载并安装</h3><p>打开安装程序，按照向导安装 HelloDog。升级前先退出旧版本。</p></article><article><span>02</span><h3>登录 HelloDog</h3><p>官网和客户端使用同一账号。新用户先注册并验证邮箱。</p></article><article><span>03</span><h3>连接聊天账号</h3><p>添加 WhatsApp 或 Signal，设置语言，并测试一条翻译。</p></article></div></section>
    <section class="release-info glass-card"><div><span class="eyebrow">RELEASE DETAILS</span><h2>下载信息</h2></div><div class="release-grid"><span>版本<b>{{ version }}</b></span><span>发布时间<b>{{ metadata?.releasedAt ? new Date(metadata.releasedAt).toLocaleString('zh-CN', { hour12: false }) : '待获取' }}</b></span><span>文件大小<b>{{ sizeLabel }}</b></span></div><div class="checksum"><label>SHA-256 文件校验码<code>{{ metadata?.sha256 || '正在等待版本信息' }}</code></label><button class="ghost-button" :disabled="!metadata?.sha256" @click="copy(metadata.sha256, '校验码')">复制校验码</button></div></section>
  </main>
</template>
