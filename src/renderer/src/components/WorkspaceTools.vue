<script setup lang="ts">
import UiIcon from './UiIcon.vue'
import { t } from '../lib/uiLocale'
defineProps<{selected:boolean;collapsed?:boolean;line:string;offline?:boolean;refreshing?:boolean}>()
const emit=defineEmits(['settings','toggle','menu','refresh'])
</script>
<template><div class="workspace-tools">
 <button class="connection-tool" :class="{offline}" :title="offline?t('离线，草稿已保留'):line" :aria-label="t('连接诊断')" @click="emit('settings')"><UiIcon name="signal" /><span>{{offline?t('离线'):line.match(/\d+ ms/)?.[0]||t('连接')}}</span></button>
 <button v-if="selected" :disabled="refreshing" @click="emit('refresh')" :title="t('刷新当前聊天 (F5)')" :aria-label="t('刷新当前聊天')"><UiIcon name="refresh" /></button>
 <button v-if="selected" class="toolbar-collapse" :aria-expanded="!collapsed" :title="collapsed?t('展开翻译面板'):t('收起面板')" :aria-label="collapsed?t('展开翻译面板'):t('收起面板')" @click="emit('toggle')"><UiIcon name="panel" /></button>
 <button v-if="selected" @click="emit('menu')" :title="t('账号操作')" :aria-label="t('账号操作')"><UiIcon name="more" /></button>
</div></template>
<style scoped>
.workspace-tools{display:flex;gap:3px;align-items:center;flex-shrink:0}.workspace-tools button{display:flex;align-items:center;justify-content:center;gap:4px;min-width:29px;height:29px;padding:4px 5px;border:0;border-radius:6px;background:transparent;color:var(--muted);cursor:pointer;font-size:10px}.workspace-tools button:hover,.workspace-tools button[aria-expanded=true]{color:var(--text);background:var(--raised)}.workspace-tools svg{width:17px;height:17px}.workspace-tools .offline{color:#e9a780}@media(max-width:1050px){.connection-tool span{display:none}}
</style>
