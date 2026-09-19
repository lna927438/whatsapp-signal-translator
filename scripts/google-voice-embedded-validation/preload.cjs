const {contextBridge,ipcRenderer}=require('electron')
contextBridge.exposeInMainWorld('prototype',{
 snapshot:()=>ipcRenderer.invoke('embed-prototype:snapshot'),
 add:()=>ipcRenderer.invoke('embed-prototype:add'),
 choose:id=>ipcRenderer.invoke('embed-prototype:choose',id),
 back:()=>ipcRenderer.invoke('embed-prototype:back'),
 reload:()=>ipcRenderer.invoke('embed-prototype:reload'),
 signin:()=>ipcRenderer.invoke('embed-prototype:signin'),
 changed:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('embed-prototype:state',listener);return()=>ipcRenderer.removeListener('embed-prototype:state',listener)}
})
