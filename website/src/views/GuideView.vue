<template>
  <main class="knowledge-page">
    <header class="knowledge-heading">
      <span class="eyebrow">HELLODOG · GET STARTED</span>
      <h1>HelloDog 翻译器<span class="knowledge-title-detail">使用指南</span></h1>
      <p>从安装、关联账号到发出第一条翻译消息。以下说明适用于 Windows 桌面客户端；具体选项以所用版本为准。</p>
      <div class="hero-actions"><RouterLink class="primary-button" to="/download">官网下载客户端 <span>↓</span></RouterLink><RouterLink class="text-link" to="/updates">查看更新记录 →</RouterLink></div>
    </header>
    <div class="knowledge-layout">
      <nav class="knowledge-toc" aria-label="使用指南目录"><b>在这里找到答案</b><a href="#install">安装与登录</a><a href="#connect">关联聊天账号</a><a href="#translation">设置双向翻译</a><a href="#history">历史消息与表情</a><a href="#characters">字符与缓存</a><a href="#troubleshooting">遇到问题时</a></nav>
      <div class="knowledge-body">
        <section id="install" class="guide-section">
          <span class="eyebrow">01 · INSTALL</span><h2>安装与登录</h2>
          <ol><li>从 <RouterLink to="/download">HelloDog 官方下载页</RouterLink>获取 Windows x64 安装程序，核对页面上的版本和文件校验码。</li><li>升级前先退出正在运行的 HelloDog，再运行安装程序。正式版沿用已有数据目录，保留账号资料和本地草稿；独立测试窗口使用自己的数据目录。</li><li>打开客户端，使用 HelloDog 账号登录。首次注册需要完成邮箱验证；官网和客户端使用同一个 HelloDog 账号。</li></ol>
          <p class="knowledge-note">HelloDog 登录账号用于管理字符和用量。WhatsApp、Signal 需要分别关联各自的聊天账号。</p>
        </section>
        <section id="connect" class="guide-section">
          <span class="eyebrow">02 · CONNECT</span><h2>关联 WhatsApp 与 Signal</h2>
          <div class="guide-platforms">
            <article><img src="/whatsapp.svg" alt="" /><h3>WhatsApp</h3><p>在客户端点击添加账号，选择 WhatsApp。出现关联二维码后，在手机 WhatsApp 的已关联设备功能中扫描，完成登录。</p><p>等待聊天列表加载，再打开一个已有会话。需要使用代理时，在该账号的设置中配置，并先检查连接状态。</p></article>
            <article><img src="/signal.svg" alt="" /><h3>Signal</h3><p>添加 Signal 账号，按照客户端提示，在手机 Signal 的已关联设备功能中完成关联。</p><p>首次关联和媒体同步可能需要等待。关联完成后检查聊天列表和会话内容；各个 HelloDog 账号窗口独立保存关联资料。</p></article>
          </div>
          <p>HelloDog 是独立的聊天翻译软件。WhatsApp 和 Signal 的账号、设备关联及平台功能仍遵循各自服务的要求。当前独立账号代理设置仅支持 WhatsApp。</p>
        </section>
        <section id="translation" class="guide-section">
          <span class="eyebrow">03 · TRANSLATE</span><h2>设置双向聊天翻译</h2>
          <ol><li>选中要使用的聊天账号，展开翻译面板，设置“我使用的语言”和对方使用的语言。</li><li>打开“接收翻译”，在对方的文字消息旁查看译文；打开“发送翻译”，让输入内容在发送前转成对方的语言。</li><li>例如你使用中文、对方使用英语，就将自己的语言设为中文，对方语言设为英语。首次使用时先与自己或同意测试的联系人核对一条短消息。</li><li>发送后查看消息状态。翻译完成、平台发送成功和对方已读是不同状态，平台回执才表示对应的发送进度。</li></ol>
          <p>“拦截中文原文”用于避免翻译失败时误发中文原文。需要翻译群聊时还要打开“群组翻译”。发送不成功时先保留草稿，按状态提示处理。</p>
        </section>
        <section id="history" class="guide-section">
          <span class="eyebrow">04 · HISTORY</span><h2>历史消息、回复与表情</h2>
          <p>在翻译面板的“历史”选项中选择适合自己的方式：</p>
          <dl class="guide-definitions"><div><dt>新消息自动</dt><dd>主要处理新收到的消息，减少浏览旧聊天时触发翻译。</dd></div><div><dt>可见消息自动</dt><dd>滚动到历史消息后，为当前可见且需要翻译的内容处理译文。</dd></div><div><dt>点击翻译</dt><dd>需要时再对指定消息发起翻译，便于控制历史消息的用量。</dd></div></dl>
          <p>带表情的文字按文字消息处理；纯表情无需付费翻译。查看回复消息时，注意区分引用内容和本次回复。图片中的文字识别、语音转写与普通文字消息翻译属于不同能力，请以客户端实际提供的功能为准。</p>
          <p>历史译文未显示时，先确认“接收翻译”和“显示译文”已开启，群聊还需检查“群组翻译”。出现失败提示时使用该条消息的重试入口。</p>
        </section>
        <section id="characters" class="guide-section">
          <span class="eyebrow">05 · USAGE</span><h2>字符消耗与译文缓存</h2>
          <p>字符用量按成功翻译的原文计算，首尾空白不计，不按译文或附带上下文的长度收费。可以在客户端查看余额，也可以登录 <RouterLink to="/account">官网用户中心</RouterLink>核对用量。</p>
          <ul><li>同一翻译请求成功后只结算一次。刷新页面、重开聊天或恢复已有译文缓存，不会为同一个已完成请求再次扣费。</li><li>已确认失败且未结算的请求不会扣减字符。结果待确认时，客户端会继续核对原请求。</li><li>修改原文、目标语言或主动重新翻译，可能会产生新的翻译请求。历史消息首次翻译也按正常规则计费。</li><li>不同消息即使文字相同，也可能对应不同请求，不能只凭文字一样判断为同一次消耗。</li></ul>
          <p class="knowledge-note">启用云端翻译时，原文及必要上下文会发送至 HelloDog 云端和翻译服务商处理。套餐和在线支付暂未开放，字符额度目前由管理员添加。</p>
        </section>
        <section id="troubleshooting" class="guide-section">
          <span class="eyebrow">06 · HELP</span><h2>遇到问题时，先检查这些</h2>
          <details open><summary>输入后无法发送，或者一直等待</summary><p>先检查账号是否仍在线、HelloDog 连接状态和字符余额。保留当前草稿，并查看具体错误提示；结果待确认时先核对原任务，避免重复点击产生重复消息。</p><p>中文输入法选字时，Enter 会先确认候选词。Signal 的 Enter 发送行为也受“按 Enter 发送”设置影响，可先使用输入框旁的发送按钮判断是否为快捷键设置问题。</p></details>
          <details><summary>只有一部分消息有译文</summary><p>检查双方语言、接收翻译、群组翻译、历史模式和译文显示开关。滚动到需要的消息并使用单条翻译或重试入口。纯表情通常没有需要翻译的文字；翻译模型的结果仍需结合上下文判断。</p></details>
          <details><summary>如何查看新版本和管理员通知</summary><p>新版客户端提供版本提醒和消息中心。关闭弹窗后仍可在消息中心查看有效通知。也可以直接进入 <RouterLink to="/download">官网下载页</RouterLink>核对版本和更新；离线时需要恢复网络后再接收通知。</p></details>
          <details><summary>反馈问题时需要提供什么</summary><p>提供客户端版本、Windows 版本、使用的平台、问题出现时间和具体操作步骤。涉及翻译消耗时保留请求编号。截图前遮住私人消息、二维码和账号凭据，便于管理员定位问题。</p></details>
        </section>
      </div>
    </div>
  </main>
</template>
