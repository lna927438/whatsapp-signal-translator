<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { adminMfaStatus, enrollAdminMfa, verifyAdminMfa, localPreview } from './client'
const emit=defineEmits<{verified:[];cancel:[]}>()
const modal=ref<HTMLDialogElement|null>(null)
const loading=ref(true),busy=ref(false),enrolled=ref(false),error=ref(''),code=ref('')
const binding=ref<{factorId:string;qr:string;secret:string}|null>(null),showSecret=ref(false),saved=ref(false)
let active=true
async function load(){try{const status=await adminMfaStatus();if(active)enrolled.value=status.enrolled}catch(e){if(active)error.value=e instanceof Error?e.message:'无法读取安全设置。'}finally{if(active)loading.value=false}}
async function enroll(){busy.value=true;error.value='';try{const value=await enrollAdminMfa();if(active)binding.value=value}catch(e){error.value=e instanceof Error?e.message:'绑定未完成。'}finally{busy.value=false}}
async function verify(){busy.value=true;error.value='';try{await verifyAdminMfa(code.value,binding.value?.factorId);binding.value=null;code.value='';emit('verified')}catch(e){error.value=e instanceof Error?e.message:'验证未通过。';code.value=''}finally{busy.value=false}}
onMounted(()=>{modal.value?.showModal();void load()})
onUnmounted(()=>{modal.value?.close();active=false;binding.value=null;code.value=''})
</script>
<template><dialog ref="modal" class="adm-mfa-overlay" aria-labelledby="admin-mfa-title" @cancel.prevent="!busy&&emit('cancel')"><section class="adm-login-card adm-mfa">
  <span class="adm-eyebrow">HELLODOG SECURITY</span><h1 id="admin-mfa-title">{{enrolled?'管理员二次验证':'保护管理员账号'}}</h1>
  <p v-if="localPreview" class="adm-preview-note">独立测试环境，使用测试验证器。</p>
  <p v-if="loading">正在检查账号安全状态…</p>
  <template v-else>
    <p>{{enrolled?'输入验证器中的验证码。验证通过后，请继续原来的操作。':'请绑定验证器。之后进入后台和执行重要操作时，需要输入验证码。'}}</p>
    <button v-if="!enrolled&&!binding" class="adm-primary" :disabled="busy||!!error" @click="enroll">开始绑定验证器</button>
    <template v-if="binding"><img class="adm-mfa-qr" :src="binding.qr" alt="请使用验证器扫描绑定二维码" /><p class="adm-help">使用验证器扫描二维码，并在安全位置保存恢复资料。不要把二维码或密钥发送给别人。</p>
      <button class="adm-button" @click="showSecret=!showSecret">{{showSecret?'隐藏手动绑定密钥':'无法扫描？手动绑定'}}</button><code v-if="showSecret" class="adm-mfa-secret">{{binding.secret}}</code>
      <label class="adm-mfa-ack"><input v-model="saved" type="checkbox" />我已安全保存验证器恢复资料。</label>
    </template>
    <form v-if="enrolled||binding" @submit.prevent="verify"><label>验证码<input v-model="code" type="text" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" autocomplete="one-time-code" autofocus required /></label><button class="adm-primary" :disabled="busy||!!binding&&!saved">{{busy?'正在验证…':binding?'验证并完成绑定':'验证并继续'}}</button></form>
  </template>
  <p v-if="error" class="adm-error" role="alert">{{error}}</p><p class="adm-help">验证器丢失时，请按管理员恢复流程处理，不会通过客服聊天索取你的密码或验证码。</p><button class="adm-button" :disabled="busy" @click="emit('cancel')">退出登录</button>
</section></dialog></template>
<style scoped>
dialog.adm-mfa-overlay{width:100vw;height:100dvh;max-width:none;max-height:none;margin:0;border:0;box-sizing:border-box;color:inherit}
.adm-mfa-overlay{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;background:#17372cc7;padding:24px;overflow:auto}.adm-mfa{width:min(100%,470px);max-height:calc(100vh - 48px);overflow:auto}.adm-mfa-qr{display:block;width:200px;height:200px;margin:16px auto;background:white;border:10px solid white}.adm-mfa-secret{display:block;overflow-wrap:anywhere;padding:12px;background:#f2f4ed;margin:12px 0}.adm-mfa-ack{display:flex;gap:8px;align-items:center;margin:14px 0}.adm-mfa-ack input{width:auto}.adm-mfa form{display:grid;gap:16px;margin:18px 0}
</style>
