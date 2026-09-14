<script setup lang="ts">
import {onMounted,ref} from 'vue'
import {authCaptcha} from '../lib/authChallenge'
const error=ref(''),busy=ref(false)
async function verify(){busy.value=true;error.value='';try{const nonce=new URLSearchParams(location.hash.slice(1)).get('nonce');if(!nonce||!/^[a-f0-9]{32}$/.test(nonce))throw new Error('请从 HelloDog 登录页面打开安全验证。');const token=await authCaptcha(true);location.hash=new URLSearchParams({nonce,token:token!}).toString()}catch(e){error.value=e instanceof Error?e.message:'安全验证未完成。'}finally{busy.value=false}}
onMounted(verify)
</script>
<template><main style="max-width:480px;margin:48px auto;padding:24px"><h1>HelloDog 安全验证</h1><p>完成后将自动返回客户端。本页不会索取账号密码。</p><p v-if="error" role="alert">{{error}}</p><button v-if="error" :disabled="busy" @click="verify">重新验证</button></main></template>
