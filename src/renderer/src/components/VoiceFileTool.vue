<script setup lang="ts">
import {ref,watch,onUnmounted} from 'vue'
import {t,uiError} from '../lib/uiLocale'
import {voiceAudioWav} from '../../../shared/voiceAudio'
const props=defineProps<{accounts:any[];selectedId?:string}>()
const validAccount=(id?:string)=>Boolean(id&&props.accounts.some(item=>item.id===id))
const initialAccount=()=>validAccount(props.selectedId)?props.selectedId!:props.accounts[0]?.id||''
const account=ref(initialAccount()),busy=ref(false),stage=ref(''),status=ref(''),original=ref(''),translated=ref(''),audioId=ref(''),filename=ref('')
let revision=0,disposed=false,activeUrl=''
function releaseUrl(){if(activeUrl){URL.revokeObjectURL(activeUrl);activeUrl=''}}
function reset(){revision++;releaseUrl();busy.value=true;stage.value='';original.value='';translated.value='';audioId.value='';filename.value='';status.value='';busy.value=false}
function cancel(){reset();status.value=t('已取消本次语音处理。')}
watch(account,reset,{flush:'sync'})
watch(()=>props.selectedId,()=>{account.value=initialAccount()},{flush:'sync'})
watch(()=>props.accounts.map(item=>item.id).join('|'),()=>{if(!validAccount(account.value))account.value=initialAccount()},{flush:'sync'})
watch(original,()=>{if(!busy.value||stage.value==='translating'){revision++;busy.value=false;stage.value='';translated.value='';status.value=t('核对识别文字后翻译，可先修改识别有误的内容。')}},{flush:'sync'})
onUnmounted(()=>{disposed=true;reset()})
async function choose(event:Event){
 const input=event.target as HTMLInputElement,file=input.files?.[0];input.value='';if(!file||disposed||!validAccount(account.value))return
 reset();const current=++revision,id=account.value;busy.value=true;stage.value='recognizing';status.value=t('正在识别语音…');filename.value=file.name
 let url=''
 try{if(file.size>20*1024*1024)throw new Error(t('请选择 5 分钟以内的语音。'));url=URL.createObjectURL(file);activeUrl=url;const bytes=await voiceAudioWav(url);if(disposed||current!==revision)return;
  const result=await window.desktopAPI.recognizeVoice(id,bytes);if(disposed||current!==revision)return;
  if(!result||typeof result.text!=='string'||!result.text.trim()||Array.from(result.text).length>12000||!/^[a-f0-9]{64}$/.test(result.audioId))throw new Error(t('语音识别失败，请重试。'))
  original.value=result.text;audioId.value=result.audioId;status.value=t('核对识别文字后翻译，可先修改识别有误的内容。')
 }catch(error:any){if(!disposed&&current===revision)status.value=error?.message||t('语音识别失败，请重试。')}
 finally{if(url&&activeUrl===url)releaseUrl();if(current===revision){busy.value=false;stage.value=''}}
}
async function translate(){
 if(disposed||busy.value||!validAccount(account.value)||!audioId.value||!original.value.trim())return
 const current=revision;busy.value=true;stage.value='translating';translated.value='';status.value=t('正在翻译…')
 try{const text=await window.desktopAPI.translateVoiceFile(account.value,audioId.value,original.value);if(!disposed&&current===revision){if(typeof text!=='string'||!text.trim())throw new Error(t('翻译失败，请重试。'));translated.value=text;status.value=t('语音翻译完成')}}
 catch(error:any){if(!disposed&&current===revision)status.value=error?.message||t('翻译失败，请重试。')}
 finally{if(current===revision){busy.value=false;stage.value=''}}
}
</script>
<template><section class="voice-file-tool">
 <h3>{{t('语音文件翻译')}}</h3>
 <p>{{t('WhatsApp 或 Signal 的语音可先保存为文件，再在这里识别和翻译。')}}</p>
 <label>{{t('聊天账号')}}<select v-model="account" :disabled="busy"><option v-for="item in accounts" :key="item.id" :value="item.id">{{item.label}}</option></select></label>
 <label class="voice-file-pick">{{t('选择语音文件')}}<input type="file" accept=".wav,.mp3,.m4a,.ogg,.opus,.aac,.webm,.flac" :disabled="busy||!account" @change="choose" /></label>
 <button v-if="(busy||filename)&&stage!=='translating'" class="voice-file-cancel" @click="cancel">{{t('取消')}}</button>
 <p>{{filename}}</p><p role="status">{{uiError(status)}}</p>
 <template v-if="audioId"><textarea v-model="original" :disabled="busy" maxlength="12000" :aria-label="t('语音识别文字')"/><button :disabled="busy||!original.trim()" @click="translate">{{t('确认并翻译')}}</button><small>{{t('识别在本机完成；确认后的文字翻译成功按字符计费。')}}</small></template>
 <p v-if="translated" class="voice-file-result">{{translated}}</p>
</section></template>
<style scoped>.voice-file-tool{border:1px solid #77889655;padding:14px;border-radius:10px;margin:16px 0;min-width:0}.voice-file-tool p{overflow-wrap:anywhere}.voice-file-tool label{display:block;margin:10px 0}.voice-file-tool select,.voice-file-tool input,.voice-file-tool textarea{box-sizing:border-box;width:100%;max-width:100%;margin-top:6px}.voice-file-tool textarea{min-height:100px}.voice-file-tool small{display:block;margin-top:8px}.voice-file-result{white-space:pre-wrap;overflow-wrap:anywhere}</style>
