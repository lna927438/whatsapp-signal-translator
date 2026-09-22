<script setup lang="ts">
import { t, uiLanguage, languageName, uiError } from '../lib/uiLocale'

import { computed, ref, watch, onUnmounted } from 'vue'
import QRCode from 'qrcode'
import ConfirmColor from './ConfirmColor.vue'
import SignalGallery from './SignalGallery.vue'
import type { SignalConversationPreference } from '../../../shared/signalPreferences'
const props = defineProps<{ recordId: string; account: string; peer: string; preference: SignalConversationPreference; messages: any[]; contacts: any[] }>()
const emit = defineEmits(['close','change','search','conversation'])
const detail = ref<any>(null), error = ref(''), busy = ref(false), page = ref('profile')
const identities = ref<any[]>([]), checked = ref(false), safetyQr = ref(''), confirmAction = ref(''), addMembers = ref<string[]>([])
let generation = 0, disposed = false
const grouped = computed(() => detail.value?.kind === 'group')
const membersAllowed = computed(() => grouped.value && (detail.value?.permissionAddMember !== 'ONLY_ADMINS' || detail.value?.members?.some((member:any) => member.id === props.account && member.isAdmin)))
async function load() {
  const version = ++generation; error.value = ''; detail.value = null; page.value = 'profile'; checked.value = false; confirmAction.value = ''
  try {
    const value = await window.desktopAPI.signalDetails(props.recordId, props.peer)
    if (disposed || generation !== version) return
    detail.value = value
    void window.desktopAPI.signalAvatar(props.recordId, props.peer).then((avatar:string) => { if (!disposed && generation === version && detail.value) detail.value.avatar = avatar }).catch(() => {})
  } catch (e:any) { if (!disposed && generation === version) error.value = e.message }
}
async function run(action: () => Promise<any>, reload = false) {
  if (busy.value) return
  const version = generation; busy.value = true; error.value = ''
  try { await action(); if (!disposed && version === generation) { emit('change'); confirmAction.value = ''; if (reload) await load() } }
  catch (e:any) { if (!disposed && version === generation) error.value = e.message || t('操作暂时无法完成。') }
  finally { busy.value = false }
}
function pref(patch: any) { return run(() => window.desktopAPI.signalConversationPreferences(props.recordId, props.peer, patch)) }
async function saveColor(color: string) {
  await window.desktopAPI.signalConversationPreferences(props.recordId, props.peer, { color })
  emit('change')
}
function timer(event: Event) { const expiration = Number((event.target as HTMLSelectElement).value); return run(() => grouped.value ? window.desktopAPI.signalSaveGroup(props.recordId, props.peer, { expiration }) : window.desktopAPI.signalSaveContact(props.recordId, props.peer, { expiration }), true) }
function addGroupMembers() { return run(() => window.desktopAPI.signalSaveGroup(props.recordId, props.peer, { members: [...addMembers.value] }), true) }
async function safety() {
  page.value = 'safety'; safetyQr.value = ''; checked.value = false
  await run(async () => {
    identities.value = (await window.desktopAPI.signalSafety(props.recordId, props.peer)).sort((a:any,b:any) => b.addedTimestamp - a.addedTimestamp)
    const current = identities.value[0]
    if (current?.scannableSafetyNumber) {
      const data = Uint8Array.from(atob(current.scannableSafetyNumber), character => character.charCodeAt(0))
      safetyQr.value = await QRCode.toDataURL([{ data, mode: 'byte' }], { width: 240, margin: 2 })
    }
  })
}
function verify() { return run(async () => { await window.desktopAPI.signalVerifySafety(props.recordId, props.peer, identities.value[0].safetyNumber); identities.value[0].trustLevel = 'TRUSTED_VERIFIED'; checked.value = false }) }
function confirm() { return run(async () => {
  if (confirmAction.value === 'quit') { await window.desktopAPI.signalQuitGroup(props.recordId, props.peer); emit('close') }
  else await window.desktopAPI.signalBlock(props.recordId, props.peer, !detail.value.blocked)
}, true) }
watch(() => [props.recordId, props.peer], load, { immediate: true })
onUnmounted(() => { disposed = true; generation++ })
</script>
<template>
  <aside class="signal-details" :aria-label="t('Signal 联系人资料')">
    <header><button @click="page === 'profile' ? emit('close') : page = 'profile'" :aria-label="page === 'profile' ? t('关闭联系人资料') : t('返回联系人资料')">‹</button><b>{{ page === 'safety' ? t('查看安全码') : page === 'media' ? t('媒体、链接和文件') : page === 'members' ? t('添加群成员') : t('资料') }}</b><button @click="emit('close')" :aria-label="t('关闭资料页')">×</button></header>
    <div class="sd-scroll">
      <p v-if="error" class="sd-error" role="alert">{{ uiError(error) }}</p>
      <div v-if="!detail" class="sd-loading"><p>{{ error ? t('资料暂时无法读取。') : t('正在读取资料…') }}</p><button v-if="error" @click="load">{{ t('重试') }}</button></div>
      <template v-else-if="page === 'profile'">
        <div class="sd-identity"><img v-if="detail.avatar" :src="detail.avatar" :alt="t('联系人头像')" /><span v-else class="sd-avatar">{{ grouped ? t('群') : detail.name?.slice(0,2) }}</span><h2>{{ detail.name }}</h2><p v-if="detail.number">{{ detail.number }}</p><p v-if="detail.username">@{{ detail.username }}</p><p v-if="detail.about || detail.description">{{ detail.about || detail.description }}</p></div>
        <div class="sd-actions"><button @click="emit('search')">⌕<small>{{ t('搜索') }}</small></button><button :disabled="busy" @click="pref({mutedUntil: (preference.mutedUntil || 0) > Date.now() ? 0 : Number.MAX_SAFE_INTEGER})">♧<small>{{ (preference.mutedUntil || 0) > Date.now() ? t('取消静音') : t('静音') }}</small></button><button :disabled="busy" @click="pref({archived: !(preference.archived ?? detail.archived)})">▣<small>{{ (preference.archived ?? detail.archived) ? t('取消存档') : t('存档') }}</small></button></div>
        <label class="sd-row"><span>{{ t('限时消息') }}<small>{{ t('此后的消息会按设定时长消失。') }}</small></span><select :value="detail.expiration || 0" :disabled="busy" @change="timer"><option :value="0">{{ t('关闭') }}</option><option :value="30">{{ t('30 秒') }}</option><option :value="300">{{ t('5 分钟') }}</option><option :value="3600">{{ t('1 小时') }}</option><option :value="28800">{{ t('8 小时') }}</option><option :value="86400">{{ t('1 天') }}</option><option :value="604800">{{ t('1 周') }}</option><option :value="2419200">{{ t('4 周') }}</option></select></label>
        <div class="sd-row"><ConfirmColor :key="peer" :label="t('聊天颜色')" :value="preference.color || '#3f6ac4'" :disabled="busy" :save="saveColor" /></div>
        <label class="sd-row">{{ t('静音时长') }}<select :disabled="busy" :value="(preference.mutedUntil || 0) > Date.now() ? -1 : 0" @change="pref({mutedUntil: Number(($event.target as HTMLSelectElement).value) === 0 ? 0 : Number(($event.target as HTMLSelectElement).value) === -1 ? Number.MAX_SAFE_INTEGER : Date.now() + Number(($event.target as HTMLSelectElement).value)})"><option :value="0">{{ t('不静音') }}</option><option :value="3600000">{{ t('1 小时') }}</option><option :value="28800000">{{ t('8 小时') }}</option><option :value="86400000">{{ t('1 天') }}</option><option :value="-1">{{ t('持续静音') }}</option></select></label>
        <button class="sd-row sd-link" @click="page = 'media'">{{ t('媒体、链接和文件') }}<span>›</span></button>
        <button v-if="!grouped && peer !== account" class="sd-row sd-link" @click="safety">{{ t('查看安全码') }}<span>›</span></button>
        <label class="sd-row">{{ t('置顶聊天') }}<input type="checkbox" :checked="preference.pinned === true" :disabled="busy" @change="pref({pinned: !preference.pinned})" /></label>
        <section v-if="grouped" class="sd-groups"><h3>{{ t('群成员 · ') }}{{ detail.members?.length || 0 }}</h3><button v-if="membersAllowed" @click="page = 'members'">{{ t('＋ 添加成员') }}</button><button v-for="member in detail.members" :key="member.id" @click="emit('conversation', member.id)"><span class="sd-member-avatar">{{ member.name?.slice(0,1) }}</span><span>{{ member.name }}<small v-if="member.isAdmin">{{ t('管理员') }}</small></span></button></section>
        <section v-else class="sd-groups"><h3>{{ t('共同群组 · ') }}{{ detail.sharedGroups?.length || 0 }}</h3><button v-for="group in detail.sharedGroups" :key="group.id" @click="emit('conversation', group.id)">{{ group.name }} <span>›</span></button></section>
        <button v-if="peer !== account" class="sd-row sd-link sd-danger" :disabled="busy" @click="confirmAction = 'block'">{{ detail.blocked ? t('解除屏蔽') : t('屏蔽') }}</button><button v-if="grouped" class="sd-row sd-link sd-danger" :disabled="busy" @click="confirmAction = 'quit'">{{ t('退出群组…') }}</button>
        <div v-if="confirmAction" class="sd-confirm" role="alert"><p>{{ confirmAction === 'quit' ? t('退出这个群组？退出后将无法继续接收群消息。') : detail.blocked ? t('解除此联系人的屏蔽？') : t('屏蔽后，不再接收此联系人或群组的新消息。') }}</p><button :disabled="busy" @click="confirm">{{ t('确认') }}</button><button :disabled="busy" @click="confirmAction = ''">{{ t('取消') }}</button></div>
      </template>
      <template v-else-if="page === 'safety'">
        <p>{{ t('与对方当面或通过可信渠道核对下面的安全码。身份未变化时，无需重复验证。') }}</p><img v-if="safetyQr" class="sd-safety-qr" :src="safetyQr" :alt="t('Signal 安全码二维码')" /><p class="sd-safety-number">{{ identities[0]?.safetyNumber || (busy ? t('正在读取…') : t('尚未取得此联系人的安全码。请先接收一条消息。')) }}</p><p v-if="identities[0]">{{ identities[0].trustLevel === 'TRUSTED_VERIFIED' ? t('已验证') : identities[0].trustLevel === 'UNTRUSTED' ? t('安全码发生变化，需要核实') : t('尚未手动验证') }}</p><label v-if="identities[0]" class="sd-check"><input v-model="checked" type="checkbox" />{{ t(' 我已与对方核对，安全码一致') }}</label><button v-if="identities[0]" :disabled="busy || !checked" @click="verify">{{ t('标记为已验证') }}</button>
      </template>
      <template v-else-if="page === 'media'">
        <SignalGallery :account-id="recordId" :peer="peer" :messages="messages" />
      </template>
      <template v-else-if="page === 'members'">
        <p>{{ t('选择要添加到群组的联系人。') }}</p><label v-for="contact in contacts.filter(item => item.kind !== 'group' && !item.blocked && !detail.members?.some((member:any) => contact.aliases.includes(member.id)))" :key="contact.id" class="sd-row"><span>{{ contact.name }}</span><input v-model="addMembers" type="checkbox" :value="contact.id" /></label><button :disabled="busy || !addMembers.length" @click="addGroupMembers">{{ t('添加 ') }}{{ addMembers.length }}{{ t(' 位成员') }}</button>
      </template>
    </div>
  </aside>
</template>
<style scoped>
.signal-details{display:flex;flex-direction:column;width:330px;min-height:0;border-left:1px solid var(--signal-border,#3d3d3d);background:var(--signal-bg,#1c1c1c);color:var(--signal-text,#eee);flex-shrink:0}.signal-details header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--signal-border,#3d3d3d);font-size:13px}.signal-details button{border:0;border-radius:7px;background:var(--signal-button,#333);color:inherit;padding:9px 12px;cursor:pointer;font:inherit;font-size:12px}.signal-details button:disabled{opacity:.5;cursor:default}.signal-details header button{background:transparent;font-size:22px;padding:4px 10px}.sd-scroll{padding:18px 20px;overflow:auto;min-height:0}.sd-identity{text-align:center;padding:6px 0 18px}.sd-identity>img,.sd-avatar{display:grid;place-items:center;width:78px;height:78px;border-radius:50%;object-fit:cover;margin:0 auto 16px;background:#d9e5ff;color:#244184;font-size:25px}.sd-identity h2{font-size:19px;line-height:1.5;overflow-wrap:anywhere;margin:8px 0}.signal-details p{font-size:12px;line-height:1.7;color:var(--signal-muted,#b3b3b3)}.sd-identity p{margin:5px 0}.sd-actions{display:flex;justify-content:center;gap:10px;padding:0 0 20px}.sd-actions button{font-size:20px;width:70px}.sd-actions small{display:block;font-size:10px;margin-top:6px}.sd-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:17px 0;border-bottom:1px solid var(--signal-border,#333);font-size:12px}.sd-row small,.sd-media small,.sd-groups small{display:block;font-size:10px;color:var(--signal-muted,#aaa);line-height:1.6;margin-top:5px}.sd-row select{max-width:100px;padding:6px;background:var(--signal-button,#333);color:inherit;border:0;border-radius:7px;font-size:11px}.sd-row input[type=checkbox],.sd-check input{accent-color:#5489ff;width:17px;height:17px}.sd-row input[type=color]{width:26px;height:26px;padding:0;border:0;border-radius:50%;overflow:hidden}.sd-link{background:transparent!important;text-align:left;width:100%;border-radius:0!important}.sd-edit{padding:18px 0;border-bottom:1px solid var(--signal-border,#333);font-size:12px}.sd-edit summary{cursor:pointer}.sd-edit label{display:flex;flex-direction:column;gap:8px;margin:14px 0}.sd-edit input,.sd-edit textarea{background:var(--signal-input,#333);color:inherit;border:1px solid var(--signal-border,#444);border-radius:7px;padding:8px;min-width:0;resize:vertical}.sd-groups{padding:12px 0;border-bottom:1px solid var(--signal-border,#333)}.signal-details h3{font-size:12px;margin:18px 0 12px}.sd-groups button{display:flex;align-items:center;gap:12px;background:transparent;text-align:left;width:100%;overflow-wrap:anywhere}.sd-member-avatar{display:grid;place-items:center;width:30px;height:30px;flex-shrink:0;border-radius:50%;background:#b1c6ff;color:#234}.sd-danger{color:#ff927f!important}.sd-error{color:#ffab9e!important}.sd-confirm{border:1px solid #735449;border-radius:8px;padding:10px;margin-top:12px}.sd-confirm button{margin-right:8px}.sd-safety-qr{display:block;max-width:100%;margin:20px auto}.sd-safety-number{color:inherit!important;font-size:20px!important;text-align:center;font-variant-numeric:tabular-nums;word-spacing:8px}.sd-check{display:flex;gap:8px;align-items:center;font-size:12px;margin:20px 0}.sd-media{display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--signal-border,#333);padding:12px 0;font-size:12px}.sd-media>span{flex:1;min-width:0;overflow-wrap:anywhere}.sd-media button{padding:6px}.sd-media-preview{display:block;max-width:100%;max-height:300px;object-fit:contain}.sd-scroll>a{display:block;overflow-wrap:anywhere;color:#91b6ff;font-size:12px;padding:12px 0;border-bottom:1px solid var(--signal-border,#333)}@media(max-width:1100px){.signal-details{width:300px}}@media(max-width:850px){.signal-details{position:absolute;inset:0;width:100%;z-index:5}}
</style>
