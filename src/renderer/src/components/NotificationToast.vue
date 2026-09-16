<script setup lang="ts">
import { ref,onMounted,onUnmounted,nextTick } from 'vue'
const api=(window as any).noticeAPI,data=ref<any>(null),busy=ref(false),failed=ref(false)
let dispose:undefined|(()=>void)
async function update(value:any){data.value=value;failed.value=false;await nextTick();if(value)requestAnimationFrame(()=>{void api.painted(value.key).catch(()=>{})})}
async function action(kind:string){if(!data.value||busy.value)return;busy.value=true;try{await api.action(data.value.key,kind)}catch{failed.value=true}finally{busy.value=false}}
onMounted(()=>{dispose=api.onChange(update);void api.state().then(update)})
onUnmounted(()=>dispose?.())
</script>
<template><aside v-if="data" class="notice-card" :data-level="data.level" role="status" @mouseenter="api.hover(true)" @mouseleave="api.hover(false)">
 <header><img src="/hellodog-icon.webp" alt=""/><span>{{data.brand}}<small>{{data.category}}</small></span><button class="close" :aria-label="data.closeLabel" :title="data.closeLabel" :disabled="busy" @click="action('dismiss')">×</button></header>
 <h2>{{data.title}}</h2><p>{{data.body}}</p><footer><button class="details" :disabled="busy" @click="action('details')">{{data.detailsLabel}}</button><button v-if="data.actionLabel" class="primary" :disabled="busy" @click="action('open')">{{data.actionLabel}}</button><button v-else class="primary" :disabled="busy" @click="action('dismiss')">{{data.closeLabel}}</button></footer><small v-if="failed" class="error">{{data.errorLabel}}</small>
</aside></template>
<style>
*{box-sizing:border-box}html,body,#app{margin:0;width:100%;height:100%;background:#191e24;font-family:system-ui,"Segoe UI",sans-serif}.notice-card{height:100%;display:flex;flex-direction:column;padding:16px 18px;border:1px solid #3d5552;border-radius:14px;background:#191e24;color:#f0f6f4;box-shadow:0 10px 30px #0004;overflow:hidden}.notice-card[data-level=critical]{border-color:#d88d81}.notice-card[data-level=warning]{border-color:#c6af6c}header{display:flex;align-items:center;gap:9px}header img{width:29px;height:29px}header span{font-size:13px;font-weight:650}header small{display:block;color:#9faeaa;font-size:10px;font-weight:400}.close{margin-left:auto;align-self:flex-start;padding:0 3px;border:0;background:transparent;color:#adbeba;font-size:23px;line-height:22px;cursor:pointer}h2{font-size:16px;line-height:1.35;margin:14px 0 7px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}p{margin:0;white-space:pre-wrap;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;font-size:12px;line-height:1.6;color:#c4d2cd;overflow-wrap:anywhere}footer{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:auto;padding-top:12px}footer button{border:0;border-radius:7px;padding:8px 12px;font-size:12px;cursor:pointer}.details{padding-left:0;background:transparent;color:#b7c9c2}.primary{background:#78cdb0;color:#122a22;font-weight:600}button:disabled{opacity:.6}.error{color:#ffc3ac;font-size:10px}button:focus-visible{outline:2px solid #9bded0;outline-offset:2px}
</style>
