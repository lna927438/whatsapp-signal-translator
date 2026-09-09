<script setup lang="ts">
import QRCode from 'qrcode'
import { onMounted, onUnmounted, ref, watch } from 'vue'
const props = defineProps<{ accountRecord: any }>()
const emit = defineEmits(['linked'])
const signalAccounts = ref<string[]>([])
const activeAccount = ref(props.accountRecord.signalAccount || '')
const recipient = ref('')
const input = ref('')
const messages = ref<any[]>([])
const linkUri = ref('')
const qr = ref('')
const status = ref('')
let off: undefined | (()=>void)

async function refreshAccounts() { try { signalAccounts.value = await window.desktopAPI.signalListAccounts(); if (!activeAccount.value && signalAccounts.value[0]) activeAccount.value = signalAccounts.value[0] } catch(e:any) { status.value = e.message || String(e) } }
async function startLink() { status.value='Starting Signal link…'; const r=await window.desktopAPI.signalStartLink(); linkUri.value=r.deviceLinkUri; qr.value=await QRCode.toDataURL(linkUri.value,{width:220,margin:1}); status.value='Scan this QR code from Signal → Settings → Linked devices.' }
async function finishLink() { status.value='Waiting for Signal to finish linking…'; await window.desktopAPI.signalFinishLink(linkUri.value,'Realtime Translator'); linkUri.value=''; qr.value=''; await refreshAccounts(); if(activeAccount.value) await window.desktopAPI.updateAccount(props.accountRecord.id,{signalAccount:activeAccount.value}); emit('linked'); status.value='Signal linked.' }
async function send() { const text=input.value.trim(); if(!text||!activeAccount.value||!recipient.value.trim()) return; input.value=''; const m=await window.desktopAPI.signalSend(activeAccount.value,recipient.value.trim(),text); messages.value.push(m) }
watch(activeAccount, async (v)=>{ if(v) await window.desktopAPI.updateAccount(props.accountRecord.id,{signalAccount:v}) })
onMounted(async()=>{ await window.desktopAPI.focusPlatform({platform:'signal'}); await refreshAccounts(); off=window.desktopAPI.onSignalMessage((m:any)=>{ if(!activeAccount.value||m.account===activeAccount.value) messages.value.push(m) }) })
onUnmounted(()=>off?.())
</script>
<template>
  <div class="signal-view">
    <div class="signal-top">
      <div><h2>Signal</h2><p v-if="activeAccount">Linked as {{ activeAccount }}</p><p v-else>No linked Signal account found.</p></div>
      <select v-if="signalAccounts.length" v-model="activeAccount"><option v-for="a in signalAccounts" :value="a">{{a}}</option></select>
      <button @click="startLink">Link Signal</button>
    </div>
    <div v-if="qr" class="qr-box"><img :src="qr"/><p>{{status}}</p><button class="primary" @click="finishLink">I scanned it — finish linking</button></div>
    <p v-else-if="status" class="status">{{status}}</p>
    <div class="signal-recipient"><label>Recipient phone number<input v-model="recipient" placeholder="+1…" /></label></div>
    <div class="messages">
      <div v-for="m in messages" :key="m.timestamp+':'+m.peer" class="msg" :class="{mine:m.fromMe}"><div class="bubble"><div>{{m.original}}</div><div v-if="m.translated && m.translated!==m.original" class="translated">{{m.translated}}</div></div></div>
    </div>
    <div class="composer"><textarea v-model="input" @keydown.enter.exact.prevent="send" placeholder="Type in your language…"></textarea><button class="primary" @click="send">Translate & Send</button></div>
  </div>
</template>
