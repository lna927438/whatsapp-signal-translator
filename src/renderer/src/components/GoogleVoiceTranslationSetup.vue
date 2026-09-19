<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import { uiError, uiLanguage } from '../lib/uiLocale'
const props=defineProps<{windowId:string;windowLabel:string}>()
const emit=defineEmits<{close:[];settings:[]}>()
const panel=ref<HTMLElement>(),busy=ref(true),error=ref('')
const permissions=ref({microphone:false,notifications:false})
let disposed=false
async function load(){busy.value=true;error.value='';try{const value=await window.desktopAPI.getGoogleVoicePermissions(props.windowId);if(!disposed)permissions.value={microphone:value.microphone===true,notifications:value.notifications===true}}catch(e:any){if(!disposed)error.value=uiError(e?.message)}finally{if(!disposed)busy.value=false}}
async function change(permission:'microphone'|'notifications',event:Event){
 const input=event.target as HTMLInputElement,allowed=input.checked;input.checked=permissions.value[permission]
 if(busy.value)return
 busy.value=true;error.value=''
 try{const value=await window.desktopAPI.setGoogleVoicePermission(props.windowId,permission,allowed);if(!disposed)permissions.value={microphone:value.microphone===true,notifications:value.notifications===true}}
 catch(e:any){if(!disposed)error.value=uiError(e?.message)}finally{if(!disposed)busy.value=false}
}
function trap(event:KeyboardEvent){if(event.key!=='Tab')return;const items=[...(panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')||[])],first=items[0],last=items.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}}
onMounted(async()=>{await nextTick();panel.value?.querySelector<HTMLButtonElement>('button')?.focus();void load()})
onUnmounted(()=>{disposed=true})
</script>
<template>
 <div class="modal-backdrop" @click.self="emit('close')" @keydown.esc.stop="emit('close')">
  <section ref="panel" class="panel voice-translation-setup" role="dialog" aria-modal="true" :aria-label="uiLanguage==='en'?'Google Voice settings':'Google Voice 设置'" @keydown="trap">
   <header><h2>{{uiLanguage==='en'?'Google Voice settings':'Google Voice 设置'}}</h2><button type="button" :aria-label="uiLanguage==='en'?'Close':'关闭'" @click="emit('close')">×</button></header>
   <p class="voice-window-label">{{windowLabel}}</p>
   <p>{{uiLanguage==='en'?'Text translation is built in. Recognized text messages are previewed before sending.':'已内置短信翻译。已识别的纯文字短信会在发送前预览。'}}</p>
   <button type="button" class="secondary" @click="emit('settings')">{{uiLanguage==='en'?'Translation language and preferences':'翻译语言与偏好'}}</button>
   <p class="voice-hint">{{uiLanguage==='en'?'Translation follows your global settings. Attachments and new-recipient send protection still require validation.':'翻译沿用全局设置。附件和新建收件人发送保护仍待验证。'}}</p>
   <div class="voice-permissions">
    <label><span>{{uiLanguage==='en'?'Call microphone':'通话麦克风'}}</span><input type="checkbox" :checked="permissions.microphone" :disabled="busy" @change="change('microphone',$event)" /></label>
    <label><span>{{uiLanguage==='en'?'Desktop notifications':'桌面通知'}}</span><input type="checkbox" :checked="permissions.notifications" :disabled="busy" @change="change('notifications',$event)" /></label>
   </div>
   <p class="voice-hint">{{uiLanguage==='en'?'Applies only to this account window. Permissions reset when the window is closed.':'仅对当前账号窗口生效，关闭窗口后需重新允许。'}}</p>
   <p v-if="error" class="voice-error" role="alert">{{error}}</p>
   <footer><button v-if="error" type="button" class="secondary" :disabled="busy" @click="load">{{uiLanguage==='en'?'Retry':'重试'}}</button><button class="primary" type="button" @click="emit('close')">{{uiLanguage==='en'?'Done':'完成'}}</button></footer>
  </section>
 </div>
</template>
<style scoped>
.voice-translation-setup{width:min(510px,calc(100vw - 40px));max-height:calc(100vh - 48px);padding:24px;overflow:auto;background:var(--panel,#19232a);color:var(--text)}header{display:flex;align-items:center;justify-content:space-between;padding:0}h2{margin:0;font-size:20px}header button{border:0;background:transparent;color:var(--text);font-size:24px}.voice-window-label,.voice-hint{font-size:12px;color:var(--muted);line-height:1.7}p{line-height:1.7;font-size:14px}.voice-permissions{margin-top:22px;display:grid;gap:12px}.voice-permissions label{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid var(--border,#38474d)}.voice-permissions input{width:18px;height:18px;accent-color:#65bc9c}.voice-error{color:#f19b92}footer{display:flex;justify-content:flex-end;gap:10px;padding:0;margin-top:22px}
</style>
