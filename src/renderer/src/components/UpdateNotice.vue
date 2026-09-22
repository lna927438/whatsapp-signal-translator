<script setup lang="ts">
import { onMounted,onUnmounted,ref } from 'vue'
import { t } from '../lib/uiLocale'
import UiIcon from './UiIcon.vue'
const notice=ref<any>(null),busy=ref(false),error=ref('')
let timer:ReturnType<typeof setInterval>|undefined,disposed=false,checking=false
async function refresh(){if(checking)return;checking=true;try{const value=await window.desktopAPI.updateNotice();if(!disposed)notice.value=value}catch{}finally{checking=false}}
async function later(){busy.value=true;try{notice.value=await window.desktopAPI.snoozeUpdate(notice.value.latestVersion)}catch{error.value=t('暂时无法保存，请稍后重试。')}finally{busy.value=false}}
async function website(){try{await window.desktopAPI.openOfficialWebsite()}catch{error.value=t('官网暂时无法打开，请稍后重试。')}}
onMounted(()=>{void refresh();timer=setInterval(()=>void refresh(),3600000);window.addEventListener('online',refresh);window.addEventListener('focus',refresh)})
onUnmounted(()=>{disposed=true;if(timer)clearInterval(timer);window.removeEventListener('online',refresh);window.removeEventListener('focus',refresh)})
</script>
<template><aside v-if="notice?.show && notice.verified && notice.status === 'available'" class="update-notice" role="status" :aria-label="t('版本更新提醒')"><UiIcon name="globe" /><span>{{t('官网新版本')}} <b>{{notice.latestVersion}}</b><small>{{t('当前')}} {{notice.currentVersion}}</small></span><button @click="website">{{t('前往官网更新')}}</button><button class="update-later" :disabled="busy" @click="later">{{t('明天提醒')}}</button><span v-if="error" role="alert">{{error}}</span></aside></template>
<style scoped>
.update-notice{display:flex;align-items:center;gap:9px;padding:5px 10px;background:var(--accent-soft);border-bottom:1px solid var(--accent);color:var(--text);font-size:12px;flex-shrink:0;flex-wrap:wrap}.update-notice svg{width:16px;height:16px}.update-notice small{margin-left:9px;color:var(--muted);font-size:10px}.update-notice button{border:0;border-radius:5px;background:var(--accent);color:#fff;padding:4px 8px;cursor:pointer;font-size:11px}.update-notice .update-later{background:transparent;color:var(--muted)}
</style>
