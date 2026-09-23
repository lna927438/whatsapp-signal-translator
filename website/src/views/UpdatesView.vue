<script setup lang="ts">
const releases = [
  { version: '0.5.17', date: '2026-09-24', title: '双通道翻译、稳定性与账单显示更新', points: [
    '聊天窗口可选择 DeepSeek 或 OpenAI 翻译通道，默认使用 DeepSeek。',
    '改善翻译长时间等待与失败恢复提示；需要重试时由用户确认，不自动重发聊天消息。',
    '发送译文不再增加模型生成的段落或空行，保留用户手动输入的换行。',
    '简化主页、侧栏和设置，移除联系人备注及客户端流水；版本与更新移至设置，增加重启和官网入口。',
    '后台以两个通道的官方账单及合计为主，缺失金额不显示为零。OpenAI 每 5 分钟尝试同步，仍受官方延迟影响；DeepSeek 显示手动导入快照及时间。',
    'Google Voice 的图片送达、未读角标和桌面提醒尚未在本次正式版中重新完成实机验收。'
  ] },
  { version: '0.5.16', date: '2026-09-21', title: '翻译目标语言与发送恢复修复', points: [
    '修复要求英文时却返回中文、导致发送被拦截的问题；已是目标语言的内容保留原文。',
    '加强疑问句保护，阻止模型用回答或建议替代翻译；保留正常引用、礼貌请求和多语言内容。',
    '修复 Signal 历史译文修正后原消息无法重试，以及重试期间仍显示失败的问题。',
    '同一消息与不同编辑版本分别核对；保留原发送编号，防止恢复时覆盖较新的正文或送达状态。',
    '翻译检查与实际发送失败分别提示。请先核对原消息再手动重试，软件不会自动重发聊天消息。'
  ] },
  { version: '0.5.15', date: '2026-09-21', title: 'Google Voice 内嵌与翻译稳定性更新', points: [
    '修复问句被回答、AI 自述或拒答被当作译文的问题；为可核对的历史错误译文提供免费修复，不重复扣字符。',
    'Google Voice 在客户端内运行，支持多个账号窗口及独立代理，支持带账号密码的 SOCKS5。',
    '短信气泡内显示原文与译文，文字和本地图片发送前核对收件人、内容及翻译。',
    '修复官方导航收起时未读数字消失，以及关闭预览后自动翻译没有恢复的问题。',
    '修复新短信自动翻译未触发和登录、帮助页面误报翻译就绪；时间无法确认的消息仍可手动翻译。',
    '优化后台账本汇总速度；读取失败保留上次数据并标注时间，未取得的数值不再显示为零。',
    'Google Voice 带中文说明图片的真实送达、图片显示及对应扣费仍待实机复核；本版不将这些项目列为已完成验收。',
    '本次 Google Voice 接入范围为文字与本地图片短信；视频、音频附件、图片内容识别和 Google Photos 尚未接入，通话优化暂缓。'
  ] },
  { version: '0.5.14', date: '2026-09-17', title: '聊天体验与稳定性优化', points: [
    '修复侧栏拖动与联系人备注，支持顶部账号拖动排序。',
    '优化深色界面和通知显示，增加后台字符减少功能。',
    '优化安装包体积，保留现有功能。'
  ] },
  { version: '0.5.13', date: '2026-09-16', title: '翻译与安全稳定性提升', points: [
    '提升翻译稳定性与安全性。',
    '修复登录失效后的恢复。',
    '优化费用显示。'
  ] },
  { version: '0.5.12', date: '2026-09-16', title: '翻译与安全稳定性提升', points: [
    '改善翻译失败恢复，修复联系人备注。',
    '新增本地语音识别与语音文件翻译。',
    '优化字符扣费与余额同步，提升安全与稳定性。'
  ] },
  { version: '0.5.11', date: '2026-09-15', title: '翻译与安全稳定性提升', points: [
    '改善历史消息自动翻译和失败后的自动恢复。',
    '联系人列表与聊天顶部同步显示独立红色备注。',
    '优化用量与费用统计，提升稳定性与安全性。'
  ] },
  { version: '0.5.10', date: '2026-09-15', title: '翻译恢复与聊天体验', points: [
    '修复翻译失败后反复卡住的问题，改善重试和发送恢复。',
    '新增独立的账号红色备注和 WhatsApp 联系人备注。',
    '优化正在输入、在线和最后上线状态显示，提升稳定性。'
  ] },
  { version: '0.5.9', date: '2026-09-15', title: '翻译稳定性与发送保护', points: [
    '加强中文原文发送拦截，改善登录过期及历史翻译恢复。',
    '发送前核对可用字符，余额不足 50,000 时显示红色提醒。',
    '优化失败重试与草稿保留，提升翻译和发送稳定性。'
  ] },
  { version: '0.5.8', date: '2026-09-14', title: '安全与稳定性提升', points: [
    '提升安全防护与运行稳定性。',
    '修复 Signal 部分消息翻译、图片复制和保存问题，优化相册查看体验。'
  ] },
  { version: '0.5.7', date: '2026-09-13', title: '消息中心、版本提醒与聊天布局', points: [
    '新增右下角版本提醒、管理员消息弹窗和消息中心。提醒不取得输入焦点，关闭后仍可在消息中心查看有效通知。',
    '管理员可向全部用户或指定 HelloDog 登录邮箱发送通知，设置有效期并查看实际弹出和确认回执。',
    '修复 WhatsApp 已归档页面遮挡聊天内容和聊天区域多余竖线的问题。'
  ] },
  { version: '0.5.6', date: '', title: '图片操作与译文显示', points: [
    '补齐 WhatsApp 图片复制、图片另存为、链接复制和媒体保存等右键操作。',
    '修正部分聊天列表宽度错位，补充图片说明等文字内容的提取方式。',
    '修复联系人被误判为群聊，以及部分英文原文重复显示为中文译文的问题。'
  ] },
  { version: '0.5.5', date: '', title: '历史消息、回复与 Windows 图标', points: [
    '改进历史消息、引用回复正文和带表情文字的翻译识别；为历史消息失败提供单条重试和恢复处理。',
    '纯表情不调用付费翻译，已完成的消息译文继续复用原有记录。',
    'HelloDog 管理的 Signal 组件统一使用 HelloDog 的系统图标与通知入口。独立安装的其他软件保留自己的图标。'
  ] }
]
</script>
<template>
  <main class="knowledge-page updates-page">
    <header class="knowledge-heading"><span class="eyebrow">HELLODOG · RELEASE NOTES</span><h1>HelloDog 翻译器<span class="knowledge-title-detail">更新记录</span></h1><p>已发布版本的主要改动与升级说明。当前可下载版本、文件大小和校验码以官方下载页为准。</p><div class="hero-actions"><RouterLink class="primary-button" to="/download">查看官方下载 <span>↓</span></RouterLink><RouterLink class="text-link" to="/guide">查看使用指南 →</RouterLink></div></header>
    <section class="release-timeline" aria-label="已发布版本">
      <article v-for="release in releases" :key="release.version" class="release-entry"><div class="release-label"><b>v{{ release.version }}</b><time v-if="release.date" :datetime="release.date">{{ release.date }}</time><span>Windows 桌面版</span></div><div><h2>{{ release.title }}</h2><ul><li v-for="point in release.points" :key="point">{{ point }}</li></ul></div></article>
    </section>
    <section class="upgrade-note"><h2>安装更新前</h2><p>先退出正在运行的 HelloDog，再运行官网安装程序。正式版沿用已有数据目录，保留账号资料与本地草稿。独立测试窗口的数据不会自动合并到正式版。</p><p>更新记录描述的是相应版本的改进，翻译结果仍需结合上下文判断。平台页面变化或网络异常可能影响使用，可以参照 <RouterLink to="/guide#troubleshooting">问题排查说明</RouterLink>处理。</p><p>对应版本的源代码与开源许可可从 <RouterLink to="/download">下载页</RouterLink>获取。HelloDog 并非 WhatsApp 或 Signal 的官方产品。</p></section>
  </main>
</template>
