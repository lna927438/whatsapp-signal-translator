<script setup lang="ts">
import { ref } from 'vue'

const source = ref('今晚有空吗？我想和你聊聊这个项目。')
const translated = ref('Are you free tonight? I’d like to talk with you about this project.')

function runDemo() {
  const text = source.value.trim()
  if (!text) { translated.value = ''; return }
  const samples: Record<string, string> = {
    '你好': 'Hello',
    '你在做什么？': 'What are you doing?',
    '今天天气很好。': 'The weather is nice today.'
  }
  translated.value = samples[text] || 'Your message will be translated precisely before it is sent.'
}
</script>

<template>
  <main>
    <section class="hero section-grid">
      <div class="hero-copy">
        <span class="eyebrow">REALTIME TRANSLATOR · WINDOWS</span>
        <h1>用自己的语言聊天，<br /><em>让对方看到他的语言。</em></h1>
        <p>为 WhatsApp 与 Signal 打造的桌面实时精准翻译。收到的消息自动翻译，发送前自动转换，并由云端统一计费与管理。</p>
        <div class="hero-actions">
          <RouterLink class="primary-button" to="/download">下载 Windows 版</RouterLink>
          <RouterLink class="ghost-button" to="/login">登录用户中心</RouterLink>
        </div>
        <div class="trust-row"><span>Cloudflare API</span><span>Supabase Auth</span><span>GPT-5.6 Luna</span><span>R2 高速分发</span></div>
      </div>

      <div class="product-window glass-card">
        <div class="window-bar"><i></i><i></i><i></i><span>Realtime Translator</span></div>
        <div class="translator-preview">
          <div class="mini-sidebar"><b>译</b><span>WhatsApp 1</span><span>Signal 1</span></div>
          <div class="mini-chat">
            <div class="mini-toolbar"><span>对方：English (US)</span><span>GPT-5.6 Luna</span><span>精准翻译</span></div>
            <div class="bubble incoming"><b>Are you free tonight?</b><small>今晚有空吗？</small></div>
            <div class="bubble outgoing"><b>I’d like to talk about the project.</b><small>我想聊聊这个项目。</small></div>
            <div class="input-mock">输入中文，发送时自动翻译… <strong>➜</strong></div>
          </div>
        </div>
      </div>
    </section>

    <section class="metrics-strip">
      <div><b>WhatsApp</b><span>原生 Web 界面</span></div>
      <div><b>Signal</b><span>内置聊天界面</span></div>
      <div><b>Cloud Wallet</b><span>字符统一计费</span></div>
      <div><b>Local Cache</b><span>历史记录不重复扣费</span></div>
    </section>

    <section class="feature-section">
      <div class="section-heading"><span class="eyebrow">WHY IT WORKS</span><h2>不是翻译网页，是真正嵌进聊天流程</h2><p>把翻译放在发送与接收动作之间，不需要复制、粘贴、切窗口。</p></div>
      <div class="feature-grid">
        <article class="feature-card"><span>01</span><h3>收到即翻译</h3><p>对方发来的英文、泰文、越南文等消息自动显示中文译文。</p></article>
        <article class="feature-card"><span>02</span><h3>发送前自动转换</h3><p>你输入中文，软件先翻译成目标语言，再提交给 WhatsApp / Signal。</p></article>
        <article class="feature-card"><span>03</span><h3>禁止中文误发</h3><p>翻译失败时直接阻止中文原文发送，避免业务沟通中的尴尬事故。</p></article>
        <article class="feature-card"><span>04</span><h3>云端字符钱包</h3><p>余额、消费、翻译记录都来自 Supabase 云端，跨设备可追踪。</p></article>
        <article class="feature-card"><span>05</span><h3>历史缓存不重复扣费</h3><p>软件重启后优先读取本地翻译缓存，不重新调用模型。</p></article>
        <article class="feature-card"><span>06</span><h3>API Key 不落客户端</h3><p>OpenAI Key 保存在 Cloudflare Worker，普通用户无法查看或复制。</p></article>
      </div>
    </section>

    <section class="demo-section section-grid">
      <div class="section-heading left"><span class="eyebrow">LIVE DEMO</span><h2>先感受一下发送前翻译</h2><p>这个演示不调用真实 API，因此不会消耗字符。</p></div>
      <div class="demo-card glass-card">
        <label>你的语言<textarea v-model="source" @input="runDemo"></textarea></label>
        <div class="demo-arrow">↓</div>
        <label>对方收到的语言<textarea v-model="translated" readonly></textarea></label>
        <div class="demo-status"><i></i> 精准翻译模式 · 中文原文禁止直发</div>
      </div>
    </section>

    <section class="cta-section">
      <span class="eyebrow">READY TO START</span>
      <h2>把跨语言聊天变成正常聊天。</h2>
      <p>Windows 版现已进入云端账号与字符钱包测试阶段。</p>
      <div class="hero-actions center"><RouterLink class="primary-button" to="/download">立即下载</RouterLink><RouterLink class="ghost-button" to="/login">创建账号</RouterLink></div>
    </section>
  </main>
</template>
