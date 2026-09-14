<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue'
const props=defineProps<{title:string;busy?:boolean;locked?:boolean}>()
const emit=defineEmits<{close:[]}>()
const dialog=ref<HTMLDialogElement>()
const titleId=useId()
const prior=document.activeElement instanceof HTMLElement?document.activeElement:null
onMounted(async()=>{await nextTick();dialog.value?.showModal()})
onBeforeUnmount(()=>prior?.focus())
function cancel(e:Event){e.preventDefault();if(!props.busy&&!props.locked)emit('close')}
</script>
<template><dialog ref="dialog" class="adm-dialog" :aria-labelledby="titleId" @cancel="cancel"><header><h2 :id="titleId">{{ title }}</h2><button type="button" aria-label="关闭" :disabled="busy||locked" @click="emit('close')">×</button></header><slot /></dialog></template>
