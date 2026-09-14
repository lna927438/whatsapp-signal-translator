import {createApp, reactive, h} from 'vue'
import SignalView from '../../src/renderer/src/components/SignalView.vue'
const record=reactive({id:'fixture-signal',signalAccount:'+12025550100',localLanguage:'zh-CN',targetLanguage:'en-US',receiveAutoTranslate:false,sendAutoTranslate:true,historyMode:'visible'})
localStorage.clear()
createApp({render:()=>h(SignalView,{accountRecord:record,userId:'fixture-owner'})}).mount('#app')
Object.assign(window,{signalFixture:{enableAuto(){record.receiveAutoTranslate=true}}})
const style=document.createElement('style')
style.textContent='html,body,#app{margin:0;width:100%;height:100%;overflow:hidden;background:#17191e;color:#ecedf0;font:14px system-ui}*{box-sizing:border-box}button,input,select,textarea{font:inherit}#app>.signal-view{height:100%}'
document.head.appendChild(style)
