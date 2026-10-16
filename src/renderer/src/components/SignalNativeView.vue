<script setup lang="ts">
import { t, uiLanguage, languageName, uiError } from '../lib/uiLocale'

import { computed, onMounted, onUnmounted, ref } from 'vue'
const props=defineProps<{accountRecord:any}>(), emit=defineEmits(['conversation','changed'])
const status=ref<any>({state:'starting'}), error=ref('')
const companion=computed(()=>status.value.presentation==='companion')
let offStatus:undefined|(()=>void), offConversation:undefined|(()=>void)
async function open(){error.value='';try{status.value=await window.desktopAPI.signalDesktopOpen(props.accountRecord.id)}catch(e:any){error.value=e.message}}
async function classic(){await window.desktopAPI.signalDesktopClassic(props.accountRecord.id);emit('changed')}
onMounted(async()=>{
  offStatus=window.desktopAPI.onSignalDesktopStatus((value:any)=>{if(value.accountId===props.accountRecord.id)status.value=value})
  offConversation=window.desktopAPI.onSignalDesktopConversation((value:any)=>{if(value.accountId===props.accountRecord.id)emit('conversation',value)})
  try{status.value=await window.desktopAPI.signalDesktopStatus(props.accountRecord.id)}catch(e:any){error.value=e.message}
})
onUnmounted(()=>{offStatus?.();offConversation?.()})
</script>
<template><div class="signal-native-view"><div v-if="status.state !== 'ready' || error || companion" class="signal-native-status"><img :src="'./signal.svg'" alt=""/><h3>{{ status.state === 'starting' ? t('正在打开 Signal…') : t('Signal 桌面版') }}</h3><p>{{ uiError(error || status.error) || (companion && status.state === 'ready' ? (uiLanguage === 'en' ? 'Signal uses a separate window on Mac. Text and voice translations appear in its chat bubbles. Manage translation models and account settings here.' : 'Mac 版 Signal 在独立窗口中使用，文字与语音译文显示在聊天气泡内。翻译模型和账号设置仍在这里管理。') : t('首次使用请在手机的已关联设备中扫描二维码。')) }}</p><button v-if="status.state !== 'starting' || error" @click="open">{{ companion ? (uiLanguage === 'en' ? 'Open Signal window' : '打开 Signal 窗口') : t('重新打开') }}</button><button v-if="!companion" @click="classic">{{ t('返回原聊天窗口') }}</button></div></div></template>
<style scoped>.signal-native-view{height:100%;width:100%;position:relative;background:#191919;display:flex;align-items:center;justify-content:center}.signal-native-status{text-align:center;padding:30px;color:#b3bfd1}.signal-native-status img{width:52px}.signal-native-status h3{font-size:18px;color:#e2e8f1}.signal-native-status p{font-size:13px;max-width:450px;line-height:1.7}.signal-native-status button{margin:6px;padding:9px 14px;border:1px solid #43526a;border-radius:7px;background:#23324b;color:#d8e2f3;cursor:pointer}</style>
