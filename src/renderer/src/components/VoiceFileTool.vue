<script setup lang="ts">
import {ref,watch,onUnmounted,nextTick} from 'vue'
import {t,uiError} from '../lib/uiLocale'
import {voiceAudioWav} from '../../../shared/voiceAudio'
const props=defineProps<{accounts:any[];selectedId?:string}>()
const validAccount=(id?:string)=>Boolean(id&&props.accounts.some(item=>item.id===id))
const initialAccount=()=>validAccount(props.selectedId)?props.selectedId!:props.accounts[0]?.id||''
const account=ref(initialAccount()),busy=ref(false),status=ref(''),original=ref(''),translated=ref(''),filename=ref('')
const selectedFile=ref<File|null>(null)
const resultElement=ref<HTMLElement|null>(null)
let revision=0,disposed=false,activeUrl='',submitted=false
function releaseUrl(){if(activeUrl){URL.revokeObjectURL(activeUrl);activeUrl=''}}
function reset(){revision++;releaseUrl();busy.value=false;status.value='';original.value='';translated.value='';filename.value='';selectedFile.value=null;submitted=false}
function cancel(){const wasSubmitted=submitted;reset();status.value=t(wasSubmitted?'已取消等待；已提交的任务可能仍在处理，不会自动重发。':'已取消本次语音处理。')}
watch(account,reset,{flush:'sync'})
watch(()=>props.selectedId,()=>{const next=initialAccount();if(account.value!==next)account.value=next},{flush:'sync'})
watch(()=>props.accounts.map(item=>item.id).join('|'),()=>{if(!validAccount(account.value))account.value=initialAccount()},{flush:'sync'})
onUnmounted(()=>{disposed=true;reset()})
function choose(event:Event){
 const input=event.target as HTMLInputElement,file=input.files?.[0];input.value='';if(!file||disposed||!validAccount(account.value))return
 reset()
 if(!file.size||file.size>20*1024*1024){status.value=t('请选择 20 MB 以内、5 分钟以内的语音文件。');return}
 selectedFile.value=file;filename.value=file.name;status.value=t('已选择文件，点击“转为中文”开始。')
}
async function translate(){
 if(disposed||busy.value||!validAccount(account.value)||!selectedFile.value||translated.value)return
 const current=++revision,id=account.value,file=selectedFile.value;busy.value=true;status.value=t('正在转为中文…');original.value='';translated.value=''
 let url=''
 const authorized=()=>!disposed&&current===revision&&account.value===id&&validAccount(id)&&selectedFile.value===file
 try{
  url=URL.createObjectURL(file);activeUrl=url
  const bytes=await voiceAudioWav(url);if(!authorized())return
  submitted=true
  const result=await window.desktopAPI.translateVoiceFileAudio(id,bytes);if(!authorized())return
  if(!result||result.targetLanguage!=='zh-CN'||typeof result.text!=='string'||!result.text.trim()||Array.from(result.text).length>12000||typeof result.translation!=='string'||!result.translation.trim()||result.translation.length>40000||!/^[a-f0-9]{64}$/.test(result.audioId))throw Error(t('语音翻译失败，请重试。'))
  original.value=result.text;translated.value=result.translation;status.value=t('已转为中文')
  await nextTick();if(authorized())resultElement.value?.scrollIntoView?.({block:'nearest'})
 }catch(error:any){if(authorized())status.value=error?.message||t('语音翻译失败，请重试。')}
 finally{if(url&&activeUrl===url)releaseUrl();if(current===revision){busy.value=false;submitted=false}}
}
</script>
<template><section class="voice-file-tool" @change.stop>
 <h3>{{t('语音翻译')}}</h3>
 <p>{{t('保存 WhatsApp、Signal 或 Google Voice 的语音文件后，可在这里转为中文。')}}</p>
 <label>{{t('聊天窗口')}}<select v-model="account"><option v-for="item in accounts" :key="item.id" :value="item.id">{{item.label}}</option></select></label>
 <p v-if="!accounts.length" role="status">{{t('请先添加聊天账号或 Google Voice 窗口。')}}</p>
 <label class="voice-file-pick">{{t('选择语音文件')}}<input type="file" accept=".wav,.mp3,.m4a,.ogg,.opus,.aac,.webm,.flac" :disabled="!account" @change="choose" /></label>
 <p v-if="filename">{{filename}}</p>
 <div class="voice-file-actions"><button v-if="selectedFile&&!translated" :disabled="busy||!account" @click="translate">{{t(busy?'正在转为中文…':'转为中文')}}</button><button v-if="busy||filename" class="voice-file-cancel" @click="cancel">{{t('取消')}}</button></div>
 <p role="status">{{uiError(status)}}</p>
 <p v-if="translated" ref="resultElement" class="voice-file-result" :aria-label="t('中文译文')">{{translated}}</p>
 <details v-if="original" class="voice-file-original"><summary>{{t('查看识别原文')}}</summary><p>{{original}}</p></details>
 <small>{{t('识别在本机完成，文字翻译成功后按字符计费；不会发送聊天消息。')}}</small>
 <small>{{t('仅处理已保存的语音，不提供通话实时翻译。')}}</small>
</section></template>
<style scoped>.voice-file-tool{border:1px solid #77889655;padding:14px;border-radius:10px;margin:16px 0;min-width:0;color-scheme:dark}.voice-file-tool p{overflow-wrap:anywhere}.voice-file-tool label{display:block;margin:10px 0}.voice-file-tool select,.voice-file-tool input{box-sizing:border-box;width:100%;max-width:100%;margin-top:6px}.voice-file-tool small{display:block;margin-top:8px;line-height:1.6}.voice-file-result,.voice-file-original p{white-space:pre-wrap;overflow-wrap:anywhere}.voice-file-result{padding:12px;background:#15241f;border-radius:8px;color:#e4f5ec}.voice-file-actions{display:flex;gap:8px;flex-wrap:wrap}.voice-file-actions button{border:1px solid #426256;border-radius:7px;background:#245c48;color:#e4f5ec;padding:8px 14px;cursor:pointer;font:inherit}.voice-file-actions button:disabled{opacity:.6;cursor:wait}.voice-file-actions .voice-file-cancel{background:#222c32;border-color:#3a474e}.voice-file-original{margin:10px 0}.voice-file-original summary{cursor:pointer}</style>
