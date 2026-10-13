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
          <p class="knowledge-note">HelloDog 登录账号用于管理字符和用量。WhatsApp、Signal、Telegram 需要分别登录或关联各自的聊天账号。</p>
        </section>
        <section id="connect" class="guide-section">
          <span class="eyebrow">02 · CONNECT</span><h2>连接 WhatsApp、Signal 与 Telegram</h2>
          <div class="guide-platforms">
            <article><img src="/whatsapp.svg" alt="" /><h3>WhatsApp</h3><p>在客户端点击添加账号，选择 WhatsApp。出现关联二维码后，在手机 WhatsApp 的已关联设备功能中扫描，完成登录。</p><p>等待聊天列表加载，再打开一个已有会话。需要使用代理时，在该账号的设置中配置，并先检查连接状态。</p></article>
            <article><img src="/signal.svg" alt="" /><h3>Signal</h3><p>添加 Signal 账号，按照客户端提示，在手机 Signal 的已关联设备功能中完成关联。</p><p>首次关联和媒体同步可能需要等待。关联完成后检查聊天列表和会话内容；各个 HelloDog 账号窗口独立保存关联资料。</p></article>
          <article><img src="/telegram.svg" alt="" /><h3>Telegram</h3><p>在主页选择 Telegram 创建窗口，按内嵌官方网页提示使用二维码或手机号登录。等待会话加载后，设置双方语言和翻译通道。</p><p>每个 Telegram 窗口独立保存账号和代理配置。普通文字与图片说明经过翻译保护后发送；附件选择、联系人和聊天记录继续使用官方网页。</p></article>
          </div>
          <p>HelloDog 是独立的聊天翻译软件。各平台账号、设备关联与可用功能仍遵循官方服务要求。WhatsApp 与 Telegram 支持独立账号代理；代理可连接不代表消息必定送达。</p>
        </section>
        <section id="translation" class="guide-section">
          <span class="eyebrow">03 · TRANSLATE</span><h2>设置双向聊天翻译</h2>
          <ol><li>选中要使用的聊天账号，展开翻译面板，设置“我使用的语言”和对方使用的语言。</li><li>打开“接收翻译”，在对方的文字消息旁查看译文；打开“发送翻译”，让输入内容在发送前转成对方的语言。</li><li>例如你使用中文、对方使用英语，就将自己的语言设为中文，对方语言设为英语。首次使用时先与自己或同意测试的联系人核对一条短消息。</li><li>发送后查看消息状态。翻译完成、平台发送成功和对方已读是不同状态，平台回执才表示对应的发送进度。</li></ol>
          <p>“禁止发送中文”开启时，最终正文或图片说明仍含中文就会阻止发送；需要发送给外语联系人时，先完成翻译。关闭这个开关后，中文或中英混合内容可以直接按原稿发送，不自动翻译这段内容。切换设置会取消尚未进入发送流程的旧任务。需要翻译群聊时还要打开“群组翻译”。发送不成功时先保留草稿，按状态提示处理。</p>
          <p>Telegram 若显示“发送结果待确认”，请先查看官网聊天记录，再选择“我已核对，已经发送”或“我已核对，尚未发送”。按钮只更新原任务；尚未发送时尽可能恢复原稿，不自动重发。核对完成前，同一会话暂停新的翻译发送。</p>
          <p>Telegram 的编辑保存、定时发送、付费附件等特殊发送方式暂未开放翻译放行，遇到提示请保留草稿并改用普通发送。首次空会话或翻看旧历史时，回执可能需要人工核对；通话不属于本次翻译支持范围。</p>
          <h3>语音显示英文与中文</h3><p>WhatsApp、Signal、Telegram 的语音，以及 Google Voice 中可识别的语音信箱或音频播放器，均可点击“转为中文”。客户端直接读取所选消息的音频，完成后在原气泡内、原语音条下方显示英文和中文，不要求下载或选择文件。原语音继续保留，只有点击后才处理，不会自动发送识别文字。读取失败时在原气泡提示重试；请先确认该条语音在官方播放器中能够播放。</p><p>Telegram 或 Google Voice 首次加载时可能短暂播放所选原语音，读取后自动暂停。识别在本机完成，需要翻译的文字使用当前窗口的翻译通道。原音已是某种目标语言时复用原文；需要分别翻译成中英文时会产生各自的翻译用量，重复查看已完成结果不新增翻译。长语音的处理时间取决于长度、电脑性能和网络。不包含实时通话翻译。</p>
        </section>
        <section id="history" class="guide-section">
          <span class="eyebrow">04 · HISTORY</span><h2>历史消息、回复与表情</h2>
          <p>在翻译面板的“历史”选项中选择适合自己的方式：</p>
          <dl class="guide-definitions"><div><dt>新消息自动</dt><dd>主要处理新收到的消息，减少浏览旧聊天时触发翻译。</dd></div><div><dt>可见消息自动</dt><dd>滚动到历史消息后，为当前可见且需要翻译的内容处理译文。</dd></div><div><dt>点击翻译</dt><dd>需要时再对指定消息发起翻译，便于控制历史消息的用量。</dd></div></dl>
          <p>带表情的文字按文字消息处理；纯表情无需付费翻译。查看回复消息时，注意区分引用内容和本次回复。图片中的文字识别、语音翻译和通话属于不同能力；本版语音翻译按点击触发，不提供实时通话翻译。</p>
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
