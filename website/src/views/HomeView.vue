<script setup lang="ts">
import { computed, ref } from 'vue'
const selectedExample = ref(0)
const examples = [
  { label: '日常问候', original: '你好！很高兴认识你。', translated: 'Hello! It’s lovely to meet you.' },
  { label: '工作协作', original: '我们明天下午三点聊聊这个方案，可以吗？', translated: 'Could we discuss this proposal tomorrow at 3 pm?' },
  { label: '轻松聊天', original: '周末一起喝杯咖啡怎么样？', translated: 'How about grabbing a coffee together this weekend?' }
]
const example = computed(() => examples[selectedExample.value])
const compact = ref(false)
const showTranslation = ref(true)
</script>
<template>
  <main class="hello-home">
    <section class="hello-hero">
      <div class="hero-copy"><span class="hello-pill"><i></i> 为 WhatsApp 与 Signal 而来</span><h1>聊得来，<br />不必说同一种<span class="word-highlight">语言。</span></h1><p>你的语言，你的表达。<br />HelloDog 把翻译融入对话，让每一句 Hello，都走得更远。</p><div class="hero-actions"><RouterLink class="primary-button" to="/download">下载 Windows 版 <span>↗</span></RouterLink><a class="text-link" href="#workspace">看看怎么用 <span>↓</span></a></div><div class="hero-footnote"><span class="platform-letter">W</span><span class="platform-letter signal">S</span><small>一个工作台，连接你的跨语言对话。</small></div></div>
      <div class="hero-art"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><span class="floating-hello hello-en">Hello!</span><span class="floating-hello hello-zh">你好呀！</span><span class="floating-hello hello-es">¡Hola!</span><img src="/hellodog-icon.webp" alt="HelloDog：对话气泡中的小狗" fetchpriority="high" /><span class="art-caption">YOUR FRIENDLY TRANSLATION COMPANION</span></div>
    </section>
    <section class="promise-strip"><span><b>01</b> 收到消息，自然看懂</span><span><b>02</b> 输入中文，翻译后发送</span><span><b>03</b> 多个账号，轻松切换</span></section>
    <section id="workspace" class="workspace-section"><div class="section-heading"><span class="eyebrow">A LITTLE LESS DISTANCE.</span><h2>熟悉的聊天，多一份默契。</h2><p>语言、账号、翻译状态，都在顺手的位置。</p></div>
      <div class="product-showcase" :class="{ compact }"><div class="showcase-title"><img src="/hellodog-icon.webp" alt="" /><b>HelloDog</b><span>产品界面示例 · 非真实聊天</span><i>−　□　×</i></div><div class="showcase-body"><aside class="showcase-sidebar"><button class="demo-collapse" @click="compact = !compact" :aria-expanded="!compact" title="试试收缩侧栏">☰<span> 我的工作空间</span></button><div class="demo-account active"><b>W</b><span>日常沟通<small>WhatsApp</small></span></div><div class="demo-account"><b>S</b><span>团队协作<small>Signal</small></span></div><div class="showcase-sidebar-bottom"><span>✧</span><span>HelloDog 在你身边</span></div></aside><div class="showcase-chat"><header><div><b>日常沟通</b><small>用自己的语言，自在表达。</small></div><span class="demo-label">界面演示</span></header><div class="showcase-controls"><span>我的语言 <b>中文（简体）</b></span><span>⇄</span><span>对方的语言 <b>English</b></span><button @click="showTranslation = !showTranslation">{{ showTranslation ? '隐藏译文' : '显示译文' }}</button></div><div class="showcase-messages"><span class="chat-date">示例对话</span><div class="preview-bubble received"><p>Hey! How’s your day going?</p><small v-if="showTranslation">嘿！今天过得怎么样？</small></div><div class="preview-bubble sent"><p>Great, thanks! Glad we can finally chat.</p><small v-if="showTranslation">挺好的，谢谢！很高兴终于能聊上了。</small></div><span class="preview-caption">原文与译文，一起保留。</span></div><div class="showcase-composer"><span>输入你的想法，让 HelloDog 帮你表达…</span><b>↑</b></div></div></div></div><p class="showcase-hint">试试左侧收缩按钮和「隐藏译文」。下载客户端，连接你的真实账号。</p>
    </section>
    <section id="features" class="hello-features"><div class="section-heading left"><span class="eyebrow">MADE FOR YOUR EVERYDAY.</span><h2>小细节，<br />让聊天更顺手。</h2><p>少一点来回复制，多一点专注交流。</p><RouterLink class="text-link" to="/download">认识你的新搭档 →</RouterLink></div><div class="hello-feature-grid"><article><span>↔</span><h3>双向翻译，不打断思路</h3><p>看懂收到的消息，用中文输入，发送前转成对方的语言。</p></article><article><span>◧</span><h3>让空间跟着你走</h3><p>侧栏可收缩，账号可搜索。右键刷新、重命名、调整缩放。</p></article><article><span>✓</span><h3>发送失败，草稿还在</h3><p>网络不稳时保留任务。发送结果不明确，由你核对后继续。</p></article><article><span>◉</span><h3>连接与消费，看得清楚</h3><p>检测真实线路延迟，查看字符余额。翻译失败不扣费。</p></article></div></section>
    <section class="hello-demo"><div><span class="eyebrow">SAME YOU. ANOTHER LANGUAGE.</span><h2>换一种语言，<br />还是你的意思。</h2><p>选择一句示例，看看翻译在对话里如何呈现。</p><div class="example-tabs" role="group" aria-label="选择翻译示例"><button v-for="(item,index) in examples" :key="item.label" :class="{ active: selectedExample === index }" @click="selectedExample = index">{{ item.label }}</button></div><small>预设示例，不调用翻译服务，不消耗字符。</small></div><div class="example-card" aria-live="polite"><div><span>你说 · 中文</span><p>{{ example.original }}</p></div><b class="example-arrow">↓</b><div><span>对方读到 · English</span><p>{{ example.translated }}</p></div><img src="/hellodog-icon.webp" alt="" loading="lazy" /></div></section>
    <section class="hello-cta"><img src="/hellodog-icon.webp" alt="HelloDog" loading="lazy" /><span class="eyebrow">ONE HELLO CAN GO A LONG WAY.</span><h2>下一段对话，<br />从 HelloDog 开始。</h2><RouterLink class="primary-button" to="/download">下载 HelloDog <span>↗</span></RouterLink><small>Windows 桌面版 · 安装后登录并连接聊天账号</small></section>
  </main>
</template>
