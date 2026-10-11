<script setup lang="ts">
import { computed, ref } from 'vue'
const selectedExample = ref(0)
const examples = [
  { label: '日常问候', original: '你好！很高兴认识你。', translated: 'Hello! It’s lovely to meet you.' },
  { label: '工作协作', original: '我们明天下午三点聊聊这个方案，可以吗？', translated: 'Could we discuss this proposal tomorrow at 3 pm?' },
  { label: '轻松聊天', original: '周末一起喝杯咖啡怎么样？', translated: 'How about grabbing a coffee together this weekend?' }
]
const example = computed(() => examples[selectedExample.value])
</script>
<template>
  <main class="hello-home">
    <section class="hello-hero">
      <div class="hero-copy"><span class="hello-pill"><i></i> 连接 WhatsApp、Signal 与 Telegram</span><h1>HelloDog 翻译器<span class="hero-tagline">聊得来，不必说同一种<span class="word-highlight">语言。</span></span></h1><p>HelloDog 是一款用于 WhatsApp、Signal 和 Telegram 的 Windows 聊天翻译软件。看懂收到的消息，按对方的语言发送回复，让翻译自然融入日常聊天。</p><div class="hero-actions"><RouterLink class="primary-button" to="/download">下载 Windows 版 <span>↗</span></RouterLink><RouterLink class="text-link" to="/guide">查看使用指南 <span>↗</span></RouterLink></div><div class="hero-footnote"><img class="platform-icon" src="/whatsapp.svg" alt="WhatsApp" /><img class="platform-icon" src="/signal.svg" alt="Signal" /><img class="platform-icon" src="/telegram.svg" alt="Telegram" /><small>一个工作台，连接你的跨语言对话。</small></div></div>
      <div class="hero-art"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><span class="floating-hello hello-en">Hello!</span><span class="floating-hello hello-zh">你好呀！</span><span class="floating-hello hello-es">¡Hola!</span><img src="/hellodog-icon.webp" alt="HelloDog：对话气泡中的小狗" fetchpriority="high" /><span class="art-caption">YOUR FRIENDLY TRANSLATION COMPANION</span></div>
    </section>
    <section class="promise-strip"><span><b>01</b> 收到消息，自然看懂</span><span><b>02</b> 输入中文，翻译后发送</span><span><b>03</b> 多个账号，轻松切换</span></section>
    <section id="workspace" class="workspace-section"><div class="section-heading"><span class="eyebrow">A LITTLE LESS DISTANCE.</span><h2>熟悉的聊天，多一份默契。</h2><p>语言、账号、翻译状态，都在顺手的位置。</p></div>
      <figure class="actual-workspace"><img src="/hellodog-workspace-054.png" alt="HelloDog 0.5.4 客户端组件，紧凑账号标签与 Signal 兼容模式示例对话" loading="lazy" width="1260" height="820" /><figcaption>历史界面示例 · HelloDog 0.5.4 · Signal 兼容模式与示例数据；当前功能以新版客户端为准</figcaption></figure>
    </section>
    <section id="features" class="hello-features"><div class="section-heading left"><span class="eyebrow">MADE FOR YOUR EVERYDAY.</span><h2>小细节，<br />让聊天更顺手。</h2><p>少一点来回复制，多一点专注交流。</p><RouterLink class="text-link" to="/download">认识你的新搭档 →</RouterLink></div><div class="hello-feature-grid"><article><span>↔</span><h3>双向翻译，不打断思路</h3><p>看懂收到的消息，用中文输入，发送前转成对方的语言。</p></article><article><span>◧</span><h3>语音，也能看中英文字</h3><p>点击“转为中文”，在原语音下方查看英文和中文。保留语音，完成后可反复查看。</p></article><article><span>✓</span><h3>发送失败，草稿还在</h3><p>网络不稳时保留任务。发送结果不明确时，后台继续查询原任务。</p></article><article><span>◉</span><h3>连接与消费，看得清楚</h3><p>查看连接状态与字符余额。已确认失败不扣费，结果未明时保留原编号核对。</p></article></div></section>
    <section class="hello-demo"><div><span class="eyebrow">SAME YOU. ANOTHER LANGUAGE.</span><h2>换一种语言，<br />还是你的意思。</h2><p>选择一句示例，看看翻译在对话里如何呈现。</p><div class="example-tabs" role="group" aria-label="选择翻译示例"><button v-for="(item,index) in examples" :key="item.label" :class="{ active: selectedExample === index }" @click="selectedExample = index">{{ item.label }}</button></div><small>预设示例，不调用翻译服务，不消耗字符。</small></div><div class="example-card" aria-live="polite"><div><span>你说 · 中文</span><p>{{ example.original }}</p></div><b class="example-arrow">↓</b><div><span>对方读到 · English</span><p>{{ example.translated }}</p></div><img src="/hellodog-icon.webp" alt="" loading="lazy" /></div></section>
    <section class="product-rules"><h2>使用前，先了解这些</h2><div><article><h3>支持范围</h3><p>Windows x64 桌面端。WhatsApp 与 Telegram 使用内嵌官方网页，Signal 使用关联设备。各账号独立保存登录资料；WhatsApp 与 Telegram 可分别设置代理。需要有效账号和可用网络。</p></article><article><h3>字符与扣费</h3><p>云端翻译成功后按原文字符计费，首尾空白不计，不按译文或上下文长度收费。同一请求只成功扣费一次，缓存恢复不新增扣费。不同消息文字相同，仍可能是不同翻译。</p></article><article><h3>恢复与限制</h3><p>发送结果未知时先核对原请求。Telegram 提供人工核对入口，不自动重发；带文字的特殊编辑、定时或付费附件发送暂不放行。部分语音需选择下载后的文件处理。译文仍需结合上下文判断。</p></article></div><p>当前正式版已连接云端用户管理与用量记录。字符额度由管理员添加，套餐和在线支付暂未开放。启用云端翻译时，原文及必要上下文会发送至 HelloDog 云端和翻译服务商处理；请按需开启。</p></section>
    <section class="hello-cta"><img src="/hellodog-icon.webp" alt="HelloDog" loading="lazy" /><span class="eyebrow">ONE HELLO CAN GO A LONG WAY.</span><h2>下一段对话，<br />从 HelloDog 开始。</h2><RouterLink class="primary-button" to="/download">下载 HelloDog <span>↗</span></RouterLink><small>Windows 桌面版 · 安装后登录并连接聊天账号</small></section>
  </main>
</template>
