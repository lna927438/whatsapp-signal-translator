<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { orderedAccounts, moveAccount } from '../../../shared/accountOrder'
import { t } from '../lib/uiLocale'
import UiIcon from './UiIcon.vue'
const props=defineProps<{accounts:any[];selectedId?:string;unread:Record<string,number>;position:'top'|'side';platform:string;ordering?:boolean}>()
const emit=defineEmits(['select','menu','add','search','remove','remark','caption','reorder'])
const list=ref<HTMLElement>()
const preview=ref<string[]|null>(null),dragging=ref('')
const rows=computed(()=>{const ordered=orderedAccounts(props.accounts);return preview.value?preview.value.map(id=>ordered.find(account=>account.id===id)).filter(Boolean):ordered})
const name=(a:any)=>a.note||a.label
watch(()=>[props.selectedId,props.position,props.accounts.length],async()=>{await nextTick();list.value?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({block:'nearest',inline:'nearest'})})
let pointer:{id:number;x:number;y:number;account:string;button:HTMLElement}|undefined,suppressClickUntil=0
function finish(commit=false){
 const ids=preview.value,wasDragging=!!dragging.value,source=pointer?.account
 const captured=pointer;pointer=undefined
 if(captured){try{captured.button.releasePointerCapture(captured.id)}catch{}}
 dragging.value='';preview.value=null
 window.removeEventListener('blur',cancel)
 window.removeEventListener('pointerup',release)
 if(wasDragging)suppressClickUntil=performance.now()+300
 if(commit&&ids&&ids.some((id,index)=>id!==orderedAccounts(props.accounts)[index]?.id))emit('reorder',ids)
 if(wasDragging&&source)nextTick(()=>list.value?.querySelector<HTMLButtonElement>(`[data-account-id="${source}"] .account-switch`)?.focus({preventScroll:true}))
}
function cancel(){finish(false)}
function start(event:PointerEvent,account:any){
 if(event.button!==0||props.ordering)return
 pointer={id:event.pointerId,x:event.clientX,y:event.clientY,account:account.id,button:list.value!}
 window.addEventListener('blur',cancel)
 window.addEventListener('pointerup',release)
}
function drag(event:PointerEvent){
 if(!pointer||pointer.id!==event.pointerId)return
 if(!dragging.value&&Math.hypot(event.clientX-pointer.x,event.clientY-pointer.y)<6)return
 if(!dragging.value)pointer.button.setPointerCapture(event.pointerId)
 event.preventDefault();dragging.value=pointer.account
 const container=list.value!,bounds=container.getBoundingClientRect(),vertical=props.position==='side'
 const coordinate=vertical?event.clientY:event.clientX,start=vertical?bounds.top:bounds.left,end=vertical?bounds.bottom:bounds.right
 if(coordinate<start+28)container.scrollBy(vertical?{top:-18}:{left:-18})
 else if(coordinate>end-28)container.scrollBy(vertical?{top:18}:{left:18})
 // Test physical rectangles, not event.target: pointer capture intentionally keeps
 // events in the toolbar when the cursor crosses native chat content.
 const targets=[...container.querySelectorAll<HTMLElement>('.account-tab')]
 const target=targets.find(row=>{const b=row.getBoundingClientRect();return event.clientX>=b.left&&event.clientX<=b.right&&event.clientY>=b.top&&event.clientY<=b.bottom})
 if(target?.dataset.accountId&&target.dataset.accountId!==pointer.account)preview.value=moveAccount(rows.value.map(a=>a.id),pointer.account,target.dataset.accountId)
}
function release(event:PointerEvent){if(pointer?.id===event.pointerId)finish(true)}
function activate(account:any){if(performance.now()>=suppressClickUntil)emit('select',account)}
function move(event:KeyboardEvent,index:number){const delta=['ArrowRight','ArrowDown'].includes(event.key)?1:['ArrowLeft','ArrowUp'].includes(event.key)?-1:0;if(!delta)return;event.preventDefault();if(event.altKey){if(props.ordering)return;const to=index+delta;if(to<0||to>=rows.value.length)return;emit('reorder',moveAccount(rows.value.map(a=>a.id),rows.value[index].id,rows.value[to].id));return}list.value?.querySelectorAll<HTMLButtonElement>('.account-switch')?.[(index+delta+rows.value.length)%rows.value.length]?.focus()}
watch(()=>props.platform,cancel)
watch(()=>props.accounts.map(account=>account.id).join('|'),cancel)
onUnmounted(cancel)
</script>
<template>
 <nav class="account-navigation" :class="position" :aria-label="t('账号切换')">
  <button class="account-count" @click="emit('search')" :title="platform+' · '+t('{0} 个账号',accounts.length)" :aria-label="t('{0} 个账号',accounts.length)"><img :src="`./${platform}.svg`" alt="" /><span>{{accounts.length}}</span></button>
  <div ref="list" class="account-switch-list" @pointermove="drag" @pointerup="release" @pointercancel="cancel" @lostpointercapture="pointer && cancel()">
   <div v-for="(account,index) in rows" :key="account.id" class="account-tab" :data-account-id="account.id" :class="{active:selectedId===account.id,dragging:dragging===account.id}" @contextmenu.prevent="emit('menu',account)">
    <button class="account-switch" :aria-current="selectedId===account.id?'true':undefined" :aria-label="name(account)+(unread[account.id]?' · '+unread[account.id]+t(' 条未读'):'')" :title="account.label+(account.note?' · '+account.note:'')+' · '+t('拖动排序；双击编辑备注')" @pointerdown="start($event,account)" @dragstart.prevent @click="activate(account)" @dblclick="!dragging && emit('remark',account)" @keydown.shift.f10.prevent="emit('menu',account)" @keydown.f2.prevent="emit('remark',account)" @keydown="move($event,index)" @keydown.esc.stop="cancel">
     <span class="tab-app-icon"><img :src="`./${account.platform}.svg`" alt="" /><span v-if="unread[account.id]" class="unread-badge">{{unread[account.id]>99?'99+':unread[account.id]}}</span></span><span class="account-tab-name">{{name(account)}}</span><i v-if="account.pinned" class="account-pin"></i>
    </button>
    <button class="account-close" :title="t('移除账号入口')+' · '+name(account)" :aria-label="t('移除账号入口')+' · '+name(account)" @click.stop="emit('remove',account)">×</button>
   </div>
  </div>
  <button class="compact-tool account-add" @click="emit('add')" :title="t('添加账号')" :aria-label="t('添加账号')"><UiIcon name="plus" /></button>
  <div v-if="$slots.tools" class="account-navigation-tools"><slot name="tools" /></div>
 </nav>
</template>
<style scoped>
.account-navigation{display:flex;align-items:center;gap:4px;min-width:0;min-height:0;background:var(--surface);box-sizing:border-box}
.account-navigation.top{height:42px;padding:3px 7px;border-bottom:1px solid var(--border);flex-shrink:0}
.account-navigation.side{width:156px;flex:0 0 156px;flex-direction:column;padding:6px;border-left:1px solid var(--border)}
.account-switch-list{display:flex;gap:5px;flex:1;min-width:50px;min-height:0;padding:3px 1px;overflow:auto;scrollbar-width:thin}
.side .account-switch-list{flex-direction:column;width:100%;box-sizing:border-box;padding:3px 0}
.account-tab{position:relative;display:flex;align-items:center;flex:0 0 auto;height:31px;width:150px;border:1px solid transparent;border-radius:8px;background:var(--field);box-sizing:border-box}.account-tab.dragging{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent);opacity:.8}.account-switch{touch-action:none;user-select:none}.account-switch img{pointer-events:none}.account-tab.dragging .account-switch{cursor:grabbing}
.side .account-tab{width:100%;height:35px}.account-tab:hover,.account-tab.active{border-color:var(--accent);background:var(--accent-soft)}
.account-switch{position:relative;display:flex;align-items:center;gap:7px;flex:1;min-width:0;height:100%;padding:3px 3px 3px 6px;border:0;background:transparent;color:var(--text);cursor:pointer;text-align:left}
.account-tab-name{font-size:12px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.tab-app-icon{position:relative;flex:0 0 22px;width:22px;height:22px}.tab-app-icon img{width:22px;height:22px}
.account-count{display:flex;align-items:center;justify-content:center;gap:3px;flex:0 0 auto;height:30px;min-width:39px;padding:2px 4px;border:0;border-radius:6px;background:transparent;color:var(--muted);cursor:pointer;font-size:11px}.account-count img{width:18px;height:18px}
.account-close{display:grid;place-items:center;flex:0 0 22px;width:22px;height:22px;margin-right:2px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--muted);font-size:18px;cursor:pointer}.account-close:hover{color:var(--text);background:var(--raised)}
.account-navigation-tools{flex:0 0 auto;min-width:0;border-left:1px solid var(--border);padding-left:5px}.account-pin{bottom:0;left:3px;right:auto}
@media(max-width:1000px){.top .account-tab{width:128px}}
</style>
