<script setup lang="ts">
import {ref} from 'vue'
import {changePassword,localPreview,type AdminSession} from './client'
const props=defineProps<{session:AdminSession}>()
const current=ref(''),next=ref(''),confirm=ref(''),busy=ref(false),notice=ref(''),error=ref('')
async function save(){
  error.value='';notice.value=''
  if(next.value!==confirm.value){error.value='两次输入的新密码不一致。';return}
  busy.value=true
  try{await changePassword(props.session.email,current.value,next.value);notice.value='密码已修改。下次登录请使用新密码。';current.value='';next.value='';confirm.value=''}
  catch(e){error.value=e instanceof Error?e.message:'修改失败。'}finally{busy.value=false}
}
</script>
<template><section class="adm-card adm-account-card"><h2>主管理员</h2><dl class="adm-status-list"><div><dt>登录账号</dt><dd>{{session.email}}</dd></div><div><dt>管理权限</dt><dd>最高权限</dd></div><div><dt>管理员数量</dt><dd>{{localPreview?'样例环境':'1 个'}}</dd></div></dl>
  <p class="adm-help">管理后台与客户端使用同一登录账号。可使用现有密码登录；修改后，两处均使用新密码。</p>
  <form class="adm-edit-form" @submit.prevent="save"><h3>设置新密码</h3><label>当前密码<input v-model="current" type="password" autocomplete="current-password" required /></label><label>新密码<input v-model="next" type="password" minlength="12" maxlength="128" autocomplete="new-password" required /></label><label>确认新密码<input v-model="confirm" type="password" minlength="12" maxlength="128" autocomplete="new-password" required /></label><p class="adm-help">至少 12 个字符。密码仅提交到登录服务，不写入操作记录。</p><p v-if="error" class="adm-error" role="alert">{{error}}</p><p v-if="notice" class="adm-notice" role="status">{{notice}}</p><button class="adm-primary" :disabled="busy||localPreview">{{busy?'正在修改…':'修改密码'}}</button></form>
</section></template>
