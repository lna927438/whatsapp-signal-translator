<script setup lang="ts">
import { computed } from 'vue'

import { t, uiLanguage, languageName, uiError } from '../lib/uiLocale'

import { ref, onMounted, onUnmounted, watch } from 'vue'
import type { SignalPreferences } from '../../../shared/signalPreferences'
const props = defineProps<{ recordId: string; account: string; preferences: SignalPreferences; contacts: any[]; messageCount: number }>()
const emit = defineEmits(['close','change'])
const tab = ref('profile'), profile = ref<any>(null), devices = ref<any[]>([]), busy = ref(false), error = ref(''), saved = ref('')
const local = ref({ ...props.preferences })
const sections = computed(() => ([{ id:'general', label:t('通用'), icon:'⚙' }, { id:'appearance', label:t('外观'), icon:'◐' }, { id:'chats', label:t('聊天'), icon:'☏' }, { id:'notifications', label:t('提醒'), icon:'♧' }, { id:'privacy', label:t('隐私'), icon:'♙' }, { id:'data', label:t('数据与备份'), icon:'▤' }]))
let disposed = false
watch(() => props.preferences, value => { local.value = { ...value } })
async function run(action: () => Promise<any>, message = t('已保存')) {
  if (busy.value) return
  busy.value = true; error.value = ''; saved.value = ''
  try { await action(); if (!disposed) { saved.value = message; emit('change') } }
  catch (e:any) { if (!disposed) error.value = e.message || t('暂时无法保存，请稍后重试。') }
  finally { busy.value = false }
}
async function loadProfile() { try { const value = await window.desktopAPI.signalProfile(props.recordId); if (!disposed) { profile.value = value; void window.desktopAPI.signalAvatar(props.recordId, props.account).then((avatar:string) => { if (!disposed && profile.value?.id === value.id) profile.value.avatar = avatar }).catch(() => {}) } } catch (e:any) { if (!disposed) error.value = e.message } }
function save(key: keyof SignalPreferences) { return run(async () => { const value = await window.desktopAPI.signalSavePreferences(props.recordId, { [key]: local.value[key] }); local.value = value }) }
function saveProfile() { return run(() => window.desktopAPI.signalSaveProfile(props.recordId, { givenName: profile.value.givenName, familyName: profile.value.familyName || '', about: profile.value.about || '' }), t('个人资料已更新')) }
function photo() { return run(async () => { if (await window.desktopAPI.signalProfilePhoto(props.recordId)) await loadProfile() }, t('头像已更新')) }
function loadDevices() { return run(async () => { devices.value = await window.desktopAPI.signalDevices(props.recordId) }, '') }
function unblock(contact:any) { return run(() => window.desktopAPI.signalBlock(props.recordId, contact.id, false), t('已解除屏蔽')) }
function backup(restore: boolean) { return run(async () => { const ok = await window.desktopAPI.signalPreferencesBackup(props.recordId, restore); if (ok && restore) local.value = await window.desktopAPI.signalPreferences(props.recordId) }, restore ? t('已恢复本账号的设置') : t('设置备份已导出')) }
onMounted(loadProfile)
onUnmounted(() => { disposed = true })
</script>
<template>
  <section class="signal-settings" :aria-label="t('Signal 设置')">
    <nav class="ss-navigation" :aria-label="t('Signal 设置分类')">
      <header><button @click="emit('close')" :aria-label="t('返回 Signal 聊天')">‹</button><h2>{{ t('设置') }}</h2></header>
      <button class="ss-profile-link" :class="{selected: tab === 'profile'}" @click="tab = 'profile'"><img v-if="profile?.avatar" :src="profile.avatar" :alt="t('我的头像')" /><span v-else class="ss-avatar">{{ profile?.name?.slice(0,1) || t('我') }}</span><span><b>{{ profile?.name || t('个人资料') }}</b><small>{{ account }}</small><small v-if="profile?.username">{{ profile.username }}</small></span></button>
      <button v-for="section in sections" :key="section.id" class="ss-tab" :class="{selected: tab === section.id}" @click="tab = section.id"><span>{{ section.icon }}</span>{{ section.label }}</button>
      <p class="ss-footnote">{{ t('当前 Signal 账号') }}</p>
    </nav>
    <div class="ss-content">
      <h2>{{ tab === 'profile' ? t('个人资料') : sections.find(item => item.id === tab)?.label }}</h2>
      <p v-if="error" class="ss-error" role="alert">{{ uiError(error) }}</p><p v-if="saved" class="ss-saved" role="status">{{ saved }}</p>
      <template v-if="tab === 'profile'">
        <div v-if="profile" class="ss-profile">
          <img v-if="profile.avatar" class="ss-photo" :src="profile.avatar" :alt="t('我的头像')" /><span v-else class="ss-photo ss-avatar">{{ profile.name?.slice(0,1) || t('我') }}</span>
          <button class="ss-small" :disabled="busy" @click="photo">{{ t('编辑照片') }}</button>
          <label>{{ t('名字') }}<input v-model="profile.givenName" maxlength="64" autocomplete="off" /></label><label>{{ t('姓氏') }}<input v-model="profile.familyName" maxlength="64" autocomplete="off" /></label>
          <label>{{ t('关于') }}<textarea v-model="profile.about" maxlength="140" rows="3" /></label>
          <button class="ss-primary" :disabled="busy || !profile.givenName?.trim()" @click="saveProfile">{{ busy ? t('保存中…') : t('保存个人资料') }}</button>
          <p>{{ t('你的资料会显示给与你聊天的联系人及群组成员。') }}</p>
          <div class="ss-info"><span>{{ t('手机号') }}</span><b>{{ account }}</b></div><div class="ss-info"><span>{{ t('用户名') }}</span><b>{{ profile.username || t('尚未同步') }}</b></div>
          <p>{{ t('用户名、号码可见性和个人二维码请在手机 Signal 的个人资料中管理。') }}</p>
        </div>
        <div v-else class="ss-empty"><p>{{ error ? t('个人资料暂时无法读取。') : t('正在读取个人资料…') }}</p><button :disabled="busy" @click="loadProfile">{{ t('重新读取') }}</button></div>
      </template>
      <template v-if="tab === 'general'">
        <h3>{{ t('已关联账号') }}</h3><div class="ss-info"><span>Signal</span><b>{{ account }}</b></div>
        <p>{{ t('此设备使用手机 Signal 的关联账号。退出 HelloDog 会停止接收，关闭到托盘会继续接收。') }}</p>
        <button :disabled="busy" @click="loadDevices">{{ t('查看已关联设备') }}</button>
        <ul class="ss-devices"><li v-for="device in devices" :key="device.id"><b>{{ device.name || t('Signal 设备 ') + device.id }}</b><small v-if="device.lastSeenTimestamp">{{ t('最近在线 ') }}{{ new Date(device.lastSeenTimestamp).toLocaleDateString() }}</small></li></ul>
        <p>{{ t('移除关联设备请在手机 Signal 的“已关联设备”中操作。') }}</p>
      </template>
      <template v-if="tab === 'appearance'">
        <label class="ss-row">{{ t('主题') }}<select v-model="local.theme" :disabled="busy" @change="save('theme')"><option value="dark">{{ t('深色') }}</option><option value="light">{{ t('浅色') }}</option><option value="system">{{ t('跟随系统') }}</option></select></label>
        <label class="ss-row">{{ t('消息字号') }}<select v-model.number="local.textSize" :disabled="busy" @change="save('textSize')"><option v-for="size in [12,14,16,18,20]" :key="size" :value="size">{{ size }} px</option></select></label>
        <p>{{ t('只改变当前 Signal 账号的聊天外观。译文字号和颜色在顶部面板中设置。') }}</p>
        <div class="ss-sample" :style="{fontSize: local.textSize + 'px'}">Hello! 👋<small>{{ t('聊天文字预览') }}</small></div>
      </template>
      <template v-if="tab === 'chats'">
        <label class="ss-row">{{ t('按 Enter 发送') }}<input v-model="local.enterSends" type="checkbox" :disabled="busy" @change="save('enterSends')" /></label><p>{{ t('关闭后 Enter 换行，Ctrl+Enter 发送。中文输入法选字时不会发送。') }}</p>
        <label class="ss-row">{{ t('收到新消息后保持存档') }}<input v-model="local.keepArchived" type="checkbox" :disabled="busy" @change="save('keepArchived')" /></label>
        <p>{{ t('存档与聊天文件夹在左侧“聊天”菜单中管理。常规翻译和发送检查由后台处理。') }}</p>
      </template>
      <template v-if="tab === 'notifications'">
        <label class="ss-row">{{ t('新消息提醒') }}<select v-model="local.notifications" :disabled="busy" @change="save('notifications')"><option value="inherit">{{ t('跟随 HelloDog') }}</option><option value="always">{{ t('此账号始终提醒') }}</option><option value="off">{{ t('关闭此账号提醒') }}</option></select></label>
        <label class="ss-row">{{ t('声音') }}<input v-model="local.sound" type="checkbox" :disabled="busy" @change="save('sound')" /></label><label class="ss-row">{{ t('隐藏通知名称') }}<input v-model="local.hideNames" type="checkbox" :disabled="busy" @change="save('hideNames')" /></label>
        <p>{{ t('通知不会显示聊天正文。单个联系人的静音在资料页设置；HelloDog 总通知关闭时，此处不会覆盖总开关。') }}</p>
      </template>
      <template v-if="tab === 'privacy'">
        <h3>{{ t('此设备的隐私') }}</h3><label class="ss-row">{{ t('发送已读回执') }}<input v-model="local.readReceipts" type="checkbox" :disabled="busy" @change="save('readReceipts')" /></label>
        <p>{{ t('开启后，在此设备阅读的一对一消息会发送已读回执。安全码仅在联系人身份变化时需要核实，不是每条消息的审核。') }}</p>
        <h3>{{ t('已屏蔽') }}</h3><div v-for="contact in contacts.filter(item => item.blocked)" :key="contact.id" class="ss-row"><span>{{ contact.name }}</span><button :disabled="busy" @click="unblock(contact)">{{ t('解除屏蔽') }}</button></div><p v-if="!contacts.some(item => item.blocked)">{{ t('没有已屏蔽的联系人或群组。') }}</p>
        <h3>{{ t('手机端管理') }}</h3><p>{{ t('号码可见性、账号 PIN 和注册锁由手机 Signal 管理。语音和视频通话仍需使用手机 Signal。') }}</p>
      </template>
      <template v-if="tab === 'data'">
        <h3>{{ t('此设备的聊天记录') }}</h3><div class="ss-info"><span>{{ t('已保存消息') }}</span><b>{{ messageCount }}{{ t(' 条') }}</b></div><p>{{ t('显示此设备接收和发送的记录。手机上未同步的旧聊天不会出现在这里。') }}</p>
        <h3>{{ t('设置备份') }}</h3><p>{{ t('导出和恢复本账号的外观、发送、存档偏好及通知设置。不包含聊天正文、Signal 密钥或手机备份。') }}</p>
        <div class="ss-buttons"><button :disabled="busy" @click="backup(false)">{{ t('导出设置') }}</button><button :disabled="busy" @click="backup(true)">{{ t('恢复设置…') }}</button></div>
        <p>{{ t('Signal 的完整聊天备份和恢复仍在手机端管理。') }}</p>
      </template>
    </div>
  </section>
</template>
<style scoped>
.signal-settings{display:grid;grid-template-columns:220px minmax(0,1fr);height:100%;min-height:0;background:var(--signal-bg,#191919);color:var(--signal-text,#eee)}.ss-navigation{display:flex;flex-direction:column;gap:6px;padding:16px 12px;background:var(--signal-side,#262626);border-right:1px solid var(--signal-border,#3e3e3e);overflow:auto}.ss-navigation header{display:flex;align-items:center;gap:16px;margin-bottom:14px}.ss-navigation h2,.ss-content h2{font-size:19px;margin:0}.ss-navigation header button{font-size:26px;background:transparent;padding:0 8px}.ss-profile-link{display:flex;gap:12px;align-items:center;text-align:left;padding:12px 8px!important;min-width:0}.ss-profile-link>span:last-child{min-width:0;overflow:hidden}.ss-profile-link b,.ss-profile-link small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ss-profile-link small{font-size:11px;margin-top:4px;color:var(--signal-muted,#aaa)}.ss-profile-link img,.ss-avatar{width:42px;height:42px;object-fit:cover;border-radius:50%;flex-shrink:0}.ss-avatar{display:grid;place-items:center;background:#a5bbf3;color:#182657;font-size:22px}.ss-tab{display:flex;gap:18px;align-items:center;padding:13px 16px!important;text-align:left;background:transparent!important}.ss-tab span{width:20px;font-size:20px}.ss-tab.selected,.ss-profile-link.selected{background:var(--signal-selected,#414141)!important}.ss-footnote{margin-top:auto!important;text-align:center}.ss-content{padding:28px clamp(20px,5vw,70px);overflow:auto;min-width:0}.ss-content>h2{margin-bottom:25px}.signal-settings button{border:0;border-radius:8px;background:var(--signal-button,#373737);color:inherit;padding:9px 14px;cursor:pointer;font:inherit;font-size:13px}.signal-settings button:disabled{opacity:.5;cursor:default}.signal-settings p{font-size:12px;line-height:1.8;color:var(--signal-muted,#aaa);margin:14px 0 24px}.ss-row,.ss-info{display:flex;gap:18px;align-items:center;justify-content:space-between;padding:18px 0;border-bottom:1px solid var(--signal-border,#3e3e3e);font-size:13px}.ss-row input[type=checkbox]{width:18px;height:18px;accent-color:#5489ff}.signal-settings input:not([type=checkbox]),.signal-settings textarea,.signal-settings select{background:var(--signal-input,#2c2c2c);border:1px solid var(--signal-border,#444);color:inherit;border-radius:7px;padding:10px;min-width:0;max-width:100%;font:inherit;font-size:13px}.ss-profile{display:flex;flex-direction:column;align-items:flex-start;max-width:520px}.ss-profile label{display:flex;flex-direction:column;gap:8px;margin:12px 0;width:100%;font-size:12px;color:var(--signal-muted,#bbb)}.ss-photo{width:86px;height:86px;border-radius:50%;object-fit:cover;align-self:center;margin-bottom:14px}.ss-small{align-self:center;margin-bottom:15px}.ss-profile .ss-info{width:100%}.ss-primary{background:#4169e1!important;color:#fff!important}.ss-info b{overflow-wrap:anywhere;font-weight:500}.ss-content h3{font-size:14px;margin:24px 0 8px}.ss-devices{list-style:none;padding:0}.ss-devices li{padding:12px;border-bottom:1px solid var(--signal-border,#444);font-size:13px}.ss-devices small{display:block;margin-top:5px;color:var(--signal-muted,#aaa)}.ss-buttons{display:flex;gap:12px;flex-wrap:wrap}.ss-sample{background:#345caf;color:#fff;padding:20px;border-radius:16px;display:inline-block}.ss-sample small{display:block;margin-top:12px;font-size:11px;opacity:.7}.ss-error{color:#f2a596!important}.ss-saved{color:#76c6a4!important}.ss-empty{padding:24px 0}@media(max-width:1000px){.signal-settings{grid-template-columns:170px minmax(0,1fr)}.ss-navigation{padding:12px 8px}.ss-content{padding:22px}.ss-profile-link{gap:6px}.ss-profile-link img,.ss-profile-link .ss-avatar{width:32px;height:32px}}
</style>
