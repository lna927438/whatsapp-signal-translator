import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('noticeAPI',{
  state:()=>ipcRenderer.invoke('notice-window:state'),
  action:(key:string,action:string)=>ipcRenderer.invoke('notice-window:action',key,action),
  painted:(key:string)=>ipcRenderer.invoke('notice-window:painted',key),
  hover:(value:boolean)=>ipcRenderer.invoke('notice-window:hover',value),
  onChange:(callback:(value:unknown)=>void)=>{const fn=(_event:unknown,value:unknown)=>callback(value);ipcRenderer.on('notice-window:changed',fn);return()=>ipcRenderer.removeListener('notice-window:changed',fn)}
})
