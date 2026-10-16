<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { downloadBase } from '../lib/supabase'
const channel = ref<'stable'|'beta'>('stable')
const loading = ref(true)
const metadata = ref<any>(null)
const error = ref('')
const copied = ref('')
const macCopied = ref('')
const macPreview = {
  version: '0.5.23',
  url: `${downloadBase}/macos/preview/v0.5.23/HelloDog-0.5.23-mac-arm64-preview.dmg`,
  sourceUrl: `${downloadBase}/sources/macos/preview/v0.5.23/HelloDog-0.5.23-mac-arm64-preview-corresponding-source.zip`,
  size: 384386587,
  sha256: '8c99b5ca11a7d0c13e869354cf13890edcb574d919ba1bff45f2b6748cbcabbd'
}
const latestUrl = computed(() => `${downloadBase}/windows/latest/WhatsApp-Signal-Translator-Setup.exe`)
const versionUrl = computed(() => metadata.value?.versionKey ? `${downloadBase}/${metadata.value.versionKey}` : channel.value === 'stable' ? latestUrl.value : '')
const version = computed(() => metadata.value?.version || '最新版')
const sizeLabel = computed(() => metadata.value?.size ? `${(metadata.value.size / 1024 / 1024).toFixed(1)} MiB` : '待获取')
const sourceUrl = computed(() => /^sources\/v[\d.]+(?:-beta\.\d+)?\/HelloDog-[\w.\-]+-corresponding-source\.zip$/.test(metadata.value?.sourceKey || '') ? `${downloadBase}/${metadata.value.sourceKey}` : '')
async function loadMetadata() {
  if (!loading.value) loading.value = true
  error.value = ''; metadata.value = null
  try {
    const response = await fetch(`${downloadBase}/metadata/${channel.value === 'beta' ? 'beta/' : ''}version.json`, { cache: 'no-store', signal: AbortSignal.timeout(12000) })
    if (response.status === 404 && channel.value === 'beta') throw new Error('暂无公开测试版。本地测试包不会自动发布。')
    if (!response.ok) throw new Error(`版本信息读取失败 (${response.status})`)
    const value = await response.json()
    if (typeof value.version !== 'string' || (value.version.includes('-beta') ? 'beta' : 'stable') !== channel.value || !/^windows\/(?:beta\/)?v[\d.]+(?:-beta\.\d+)?\/[\w.\-]+\.exe$/.test(value.versionKey) || !/^[a-f0-9]{64}$/i.test(value.sha256) || !Number.isFinite(value.size) || value.size <= 0) throw new Error('版本信息暂不可用，请稍后刷新。')
    metadata.value = value
  } catch (e: any) { error.value = e?.name === 'TimeoutError' ? '获取版本信息超时。你可以重试，或使用下方固定下载入口。' : e?.message || '暂时无法读取版本信息。' }
  finally { loading.value = false }
}
async function copy(value: string, kind: string) {
  const feedback = kind.startsWith('Mac') ? macCopied : copied
  try { await navigator.clipboard.writeText(value); feedback.value = kind + '已复制' }
  catch { feedback.value = '复制未成功，请手动选择下方内容。' }
}
onMounted(loadMetadata)
</script>
<template>
  <main class="download-page hello-download">
    <nav class="download-platform-nav" aria-label="选择电脑系统"><a href="#windows">Windows x64</a><a href="#mac">Mac · Apple 芯片验收版</a></nav>
    <section id="windows" class="download-hero section-grid"><div><span class="eyebrow">YOUR NEXT CONVERSATION STARTS HERE.</span><h1>HelloDog，<br />准备好说 Hello。</h1><p>把翻译带进你的 WhatsApp、Signal 与 Telegram。<br />选择适合电脑系统的版本，连接账号，开始交流。</p><label class="download-channel">下载渠道<select v-model="channel" :disabled="loading" @change="loadMetadata"><option value="stable">稳定版</option><option value="beta">测试版</option></select></label><div class="hero-actions"><a v-if="versionUrl" class="primary-button" :href="versionUrl">下载 Windows 版 <span>↓</span></a><button class="ghost-button" :disabled="loading" @click="loadMetadata">{{ loading ? '查询版本中…' : '刷新版本' }}</button></div><p class="download-platform">Windows x64 · 需要网络连接</p><p v-if="error" class="form-message error" role="alert">{{ error }}</p></div><div class="download-card glass-card"><div class="download-product"><img src="/hellodog-icon.webp" alt="HelloDog 图标" /><div><b>HelloDog</b><small>你的跨语言聊天搭档</small></div><span class="download-badge">WINDOWS</span></div><div class="download-current"><span>当前可下载版本</span><strong>{{ loading ? '读取中…' : metadata?.version ? 'v' + version.replace(/^v/, '') : '暂未获取' }}</strong></div><div class="download-meta"><span>平台<b>Windows x64</b></span><span>安装包大小<b>{{ sizeLabel }}</b></span><span>安装方式<b>安装向导</b></span></div><a v-if="channel === 'stable'" class="text-link" :href="latestUrl">固定下载入口 →</a><small class="delivery-note">稳定版与测试版分开；暂无测试版时不替换为其他安装包。</small></div></section>
    <section id="mac" class="mac-download" aria-labelledby="mac-download-title">
      <header><div><span class="eyebrow">HELLODOG FOR MAC</span><h2 id="mac-download-title">Mac · Apple 芯片版</h2><p>v{{ macPreview.version }} · macOS 14 及以上 · M1 / M2 / M3 / M4 / M5 等 Apple 芯片</p></div><span class="preview-label">公开验收版</span></header>
      <p>适用于 Apple 芯片 Mac，暂不提供 Intel 安装包。支持同一 HelloDog 云端账号；Mac 上的 Signal 使用独立窗口，WhatsApp、Telegram 与 Google Voice 在客户端内打开。</p>
      <p><strong>本版尚未完成苹果开发者签名和公证。</strong>已完成 Mac 启动与组件检查，实际账号的聊天、翻译和发送仍需在你的 Mac 上验收。</p>
      <div class="hero-actions"><a class="primary-button" :href="macPreview.url">下载 Mac 验收版 <span>↓</span></a><span class="download-platform">DMG · {{ (macPreview.size / 1024 / 1024).toFixed(1) }} MiB</span><button class="ghost-button" @click="copy(macPreview.url, 'Mac 下载链接')">复制链接</button></div>
      <details class="mac-install-note"><summary>安装、首次打开与更新说明</summary><ol><li>打开下载的 DMG，把 HelloDog 拖入“应用程序”，然后从“应用程序”启动。升级前先正常退出旧版本。</li><li>若系统阻止打开，核对下面的文件校验码后，按<a class="text-link" href="https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac" target="_blank" rel="noopener noreferrer">苹果官方说明</a>，在“系统设置 → 隐私与安全性”中为此应用选择“仍要打开”。无需关闭系统安全保护。</li><li>登录 HelloDog 并连接聊天账号。首次使用先检查连接，再核对一条已有消息的翻译。Windows 的本地账号和草稿不会自动迁移到 Mac。</li><li>Mac 验收版通过本页手动下载安装更新。Signal 作为独立窗口运行，可从 HelloDog 切换账号或重新打开。</li></ol></details>
      <details class="mac-install-note"><summary>文件校验与对应源代码</summary><div class="checksum"><label>Mac DMG · SHA-256<code>{{ macPreview.sha256 }}</code></label><button class="ghost-button" @click="copy(macPreview.sha256, 'Mac 校验码')">复制校验码</button></div><a class="text-link" :href="macPreview.sourceUrl">下载 Mac 本版本对应源代码与开源许可 →</a></details>
      <p class="mac-feedback" aria-live="polite">{{ macCopied }}</p>
    </section>
    <section class="download-help"><div><span class="eyebrow">SLOW NETWORK? TAKE IT EASY.</span><h2>网速慢，也可以慢慢来。</h2><p>优先使用上方对应系统的版本下载链接。Mac 用户请使用 Mac 卡片中的“复制链接”。中断时，在浏览器下载列表中选择继续；支持续传的下载工具也可使用同一链接。</p><button class="ghost-button" :disabled="!versionUrl" @click="copy(versionUrl, '下载链接')">复制 Windows 下载链接</button><p class="copy-feedback" aria-live="polite">{{ copied }}</p></div><div class="download-faq"><details open><summary>安装新版本，原来的账号还在吗？</summary><p>Windows 运行安装程序；Mac 按上方说明替换“应用程序”中的 HelloDog。同一电脑上的升级沿用旧版的数据目录，保留已有账号、登录资料与本地草稿。升级前请先关闭正在运行的客户端。独立测试快捷方式继续使用测试数据，正式版不会自动合并测试账号，可能需要重新关联。</p></details><details><summary>官网下载后，如何开始使用？</summary><p>登录 HelloDog，先在设置中检查连接，再从主页添加 WhatsApp、Signal 或 Telegram，完成各自的登录或设备关联，最后设置双方语言。</p></details><details><summary>显示“翻译服务凭据无效”怎么办？</summary><p>这是服务端配置问题。管理员需要更新翻译服务凭据，重复下载客户端不能解决。已确认失败的翻译不会扣减字符。结果待确认时保留请求编号，先核对原任务。</p></details></div></section>
    <section class="install-steps"><div class="section-heading"><span class="eyebrow">THREE SMALL STEPS.</span><h2>装好，然后自在聊。</h2></div><div class="steps-grid"><article><span>01</span><h3>下载并安装</h3><p>Windows 按安装向导操作；Mac 打开 DMG，把 HelloDog 拖入“应用程序”。升级前先退出旧版本。</p></article><article><span>02</span><h3>登录 HelloDog</h3><p>官网和客户端使用同一账号。新用户先注册并验证邮箱。</p></article><article><span>03</span><h3>连接聊天账号</h3><p>添加 WhatsApp、Signal 或 Telegram，设置语言，并使用翻译测试确认连接。</p></article></div></section>
    <section class="release-info glass-card"><div><span class="eyebrow">RELEASE DETAILS</span><h2>Windows 下载信息</h2></div><div class="release-grid"><span>版本<b>{{ version }}</b></span><span>发布时间<b>{{ metadata?.releasedAt ? new Date(metadata.releasedAt).toLocaleString('zh-CN', { hour12: false }) : '待获取' }}</b></span><span>文件大小<b>{{ sizeLabel }}</b></span></div><p v-if="metadata?.notes" class="release-notes">{{ metadata.notes }}</p><p v-else>此版本尚未提供详细更新说明。</p><div class="checksum"><label>SHA-256 文件校验码<code>{{ metadata?.sha256 || '正在等待版本信息' }}</code></label><button class="ghost-button" :disabled="!metadata?.sha256" @click="copy(metadata.sha256, '校验码')">复制校验码</button></div><p v-if="sourceUrl"><a class="text-link" :href="sourceUrl">下载本版本对应源代码与开源许可 →</a></p><p>Signal 组件基于 AGPL-3.0 开源桌面端修改，HelloDog 并非 Signal、WhatsApp 或 Telegram 的官方产品。当前安装包未做代码签名，可使用上方校验码核对下载文件。</p><p>0.5.23 支持在 WhatsApp、Signal、Telegram 和 Google Voice 的可识别语音气泡内直接显示中英双语，不再要求选择音频文件；修复中文发送开关和等待中的旧任务取消。Telegram 或 Google Voice 首次加载时可能短暂播放所选原音后暂停。本轮尚未完成四个平台真实账号全流程复测，不包含实时通话翻译。详细操作和限制请查看使用指南。</p><p>0.5.4 起支持自动更新提醒；更早的正式版没有远程通知接收功能，请通过本页面或客户端手动检查更新。升级前先退出旧客户端，已绑定账号与本地草稿沿用原数据目录。</p></section>
  </main>
</template>

<style scoped>
.download-platform-nav{max-width:1120px;margin:34px auto 0;padding:0 24px;display:flex;flex-wrap:wrap;gap:10px}
.download-platform-nav a{border:1px solid var(--line);border-radius:8px;padding:11px 16px;font-size:13px;background:var(--panel-2);color:var(--text)}
#windows,#mac{scroll-margin-top:110px}
.mac-download{max-width:1070px;margin:0 auto 54px;padding:30px;border:1px solid var(--line);border-radius:18px;background:var(--panel)}
.mac-download header{display:flex;justify-content:space-between;align-items:start;gap:20px}
.mac-download h2{margin:10px 0;font-size:30px;font-weight:550;letter-spacing:-.03em}
.mac-download p,.mac-download li{font-size:13px;line-height:1.85;color:#627657}
.mac-download p{margin:8px 0}
.mac-download .preview-label{flex-shrink:0;border:1px solid #d8c583;border-radius:7px;background:#f7f0d7;color:#78622c;padding:7px 10px;font-size:12px}
.mac-download .hero-actions{margin-top:20px;align-items:center}
.mac-download .checksum{margin:16px 0}
.mac-download .checksum code{overflow-wrap:anywhere}
.mac-install-note{margin-top:22px;border-top:1px solid var(--line);padding-top:18px}
.mac-install-note summary{cursor:pointer;color:var(--text);font-size:14px}
.mac-install-note ol{padding-left:22px}
.mac-download .text-link{font-size:12px}
.mac-download .mac-feedback{min-height:20px;margin:8px 0 0}
@media(max-width:1140px){.mac-download{margin-right:24px;margin-left:24px}}
@media(max-width:640px){.download-platform-nav{margin-top:24px;padding:0 16px}.mac-download{margin-right:16px;margin-left:16px;padding:22px 18px}.mac-download header{flex-direction:column;gap:8px}.mac-download h2{font-size:26px}}
</style>
