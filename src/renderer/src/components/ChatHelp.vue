<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { uiLanguage } from '../lib/uiLocale'
const english = ref(uiLanguage.value === 'en')
watch(uiLanguage, value => { english.value = value === 'en' })
const rows = computed(() => english.value ? [
  ['Enter / Shift+Enter', 'Send / new line. Choosing an IME candidate does not send.'],
  ['Ctrl+K / Ctrl+Shift+F', 'Find a chat account.'],
  ['Ctrl+B', 'Expand or collapse the app toolbar.'],
  ['Ctrl+/', 'Open version and update settings.'],
  ['Shift+F10', 'Open the selected account menu.'],
  ['F5 / Ctrl+R', 'Refresh safely while preserving drafts and pending messages.'],
  ['Esc', 'Close a panel or image preview.'],
] : [
  ['Enter / Shift+Enter', '发送 / 换行，输入法选词时不发送。'],
  ['Ctrl+K / Ctrl+Shift+F', '搜索聊天账号。'],
  ['Ctrl+B', '收起或展开功能栏。'],
  ['Ctrl+/', '打开设置中的版本与更新。'],
  ['Shift+F10', '打开所选账号菜单。'],
  ['F5 / Ctrl+R', '安全刷新，保留草稿和正在处理的消息。'],
  ['Esc', '关闭面板或图片预览。'],
])
</script>
<template>
  <section class="chat-help" :lang="english ? 'en' : 'zh-CN'">
    <div class="help-language" aria-label="帮助语言 / Help language"><button class="secondary" :aria-pressed="!english" @click="english=false">中文</button><button class="secondary" :aria-pressed="english" @click="english=true">English</button></div>
    <h3>{{ english ? 'Chatting without interruptions' : '日常聊天与恢复' }}</h3>
    <p>{{ english ? 'Choose the account and contact, check the target language, then type and send. You can keep composing the next message while a translation is running.' : '选择账号和联系人，检查目标语言后即可输入发送。上一条正在翻译时，可以继续输入下一条。' }}</p>
    <dl class="help-shortcuts"><template v-for="row in rows" :key="row[0]"><dt>{{ row[0] }}</dt><dd>{{ row[1] }}</dd></template></dl>
    <h4>{{ english ? 'If sending seems stuck' : '发送停住时' }}</h4>
    <p>{{ english ? 'Your draft and original task are kept. Check the connection, then use Records and recovery. An unknown delivery result is not proof that sending failed. HelloDog checks the original task and does not automatically send it again.' : '草稿和原任务会保留。先检查连接，再打开“记录与恢复”。发送结果未知不代表发送失败，应用会查询原任务，不会自动再发一次。' }}</p>
    <h4>{{ english ? 'Translation and delivery are separate' : '翻译完成与消息送达分开' }}</h4>
    <p>{{ english ? 'A completed translation does not mean the contact received the message. Use the platform delivery indicator. Restoring the same cached translation adds no character charge; translating a new message or explicitly requesting a new translation is a separate operation.' : '译文完成不代表对方已收到，请以平台送达标记为准。同一译文从缓存恢复不新增字符扣费；新消息和明确发起的新翻译属于独立操作。' }}</p>
    <h4>{{ english ? 'History and media' : '历史与媒体' }}</h4>
    <p>{{ english ? 'New messages, visible history and manual translation are different history options. Images, emoji, files and calls use the platform controls. Check microphone and camera access in Windows if recording or calling is unavailable.' : '历史翻译可选仅新消息、可见历史或手动翻译。图片、表情、文件和通话使用平台原有按钮；录音或通话不可用时，检查 Windows 麦克风和摄像头权限。' }}</p>
  </section>
</template>
<style scoped>
.help-language{display:flex;gap:8px}.help-language button[aria-pressed=true]{outline:1px solid #77aaff}.help-shortcuts{display:grid;grid-template-columns:minmax(140px,200px) 1fr;gap:12px;margin:22px 0}.help-shortcuts dd{margin:0}.chat-help p{line-height:1.65;color:#aab9c7}.chat-help h4{margin-bottom:6px}@media(max-width:700px){.help-shortcuts{grid-template-columns:145px 1fr}}
</style>
