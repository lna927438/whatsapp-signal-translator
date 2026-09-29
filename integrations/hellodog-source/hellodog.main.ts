// Copyright 2026 HelloDog contributors
// SPDX-License-Identifier: AGPL-3.0-only
import { app, ipcMain, type BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export const helloDogEmbedded = process.env.HELLODOG_EMBEDDED === '1' && typeof process.send === 'function';
process.env.HELLODOG_BRIDGE_ACTIVE = helloDogEmbedded ? '1' : '0';
let notificationSender: number | undefined;
export function forwardHelloDogNotification(senderId: number, options?: { silent?: boolean }): void {
  if (helloDogEmbedded && senderId === notificationSender) process.send?.({channel:'hellodog',type:'notification',silent:options?.silent === true});
}
if (helloDogEmbedded) app.on('browser-window-created', (_event, nativeWindow) => {
  nativeWindow.setSkipTaskbar(true);
  nativeWindow.setIcon(join(app.getAppPath(), 'images/hellodog-icon.png'));
});
export function attachHelloDog(window: BrowserWindow): void {
  if (!helloDogEmbedded) return;
  const senderId = window.webContents.id;
  notificationSender = senderId;
  window.once('closed', () => { if (notificationSender === senderId) notificationSender = undefined; });
  // Windows' external child-window embedding must not suspend Blink timers or
  // React updates while the host is showing the native window.
  window.webContents.setBackgroundThrottling(false);
  window.on('focus',()=>window.webContents.focus());
  ipcMain.on('set-badge-count',(event,count:unknown)=>{
    if(event.sender.id===window.webContents.id && Number.isSafeInteger(count) && Number(count)>=0 && Number(count)<=99999) process.send?.({channel:'hellodog',type:'unread',count});
  });
  ipcMain.on('hellodog:notification',(event, options)=>forwardHelloDogNotification(event.sender.id, {silent:options?.silent === true}));
  ipcMain.on('hellodog:activate', event => {
    if(event.sender.id===window.webContents.id) process.send?.({channel:'hellodog',type:'activate'});
  });
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const voicePending = new Set<string>();
  let refreshId: string | undefined;
  let restartId: string | undefined;
  let quickReplyId: string | undefined;
  ipcMain.on('hellodog:draft-inserted',(event,result:any)=>{
    if(event.sender.id!==window.webContents.id || !quickReplyId || result?.id!==quickReplyId)return;
    process.send?.({channel:'hellodog',type:'draft-inserted',id:quickReplyId,error:Boolean(result.error)});
    quickReplyId=undefined;
  });
  window.webContents.on('before-input-event',(event,input)=>{
    if(input.type==='keyDown' && (input.key==='F5'||input.control&&input.key.toLowerCase()==='r')) {
      event.preventDefault();process.send?.({channel:'hellodog',type:'request-refresh'});
    }
  });
  ipcMain.on('hellodog:restart-ready',(event,result:any)=>{
    if(event.sender.id!==window.webContents.id || !restartId || result?.id!==restartId)return;
    process.send?.({channel:'hellodog',type:'restart-ready',id:restartId,error:Boolean(result.error)});
    restartId=undefined;
  });
  const finishRefresh = (error = false) => {
    if (!refreshId) return;
    process.send?.({channel:'hellodog',type:'refreshed',id:refreshId,error});
    refreshId=undefined;
  };
  window.webContents.on('did-finish-load',()=>finishRefresh());
  window.webContents.on('did-fail-load',()=>finishRefresh(true));
  ipcMain.on('hellodog:reload-ready',(event,result:any)=>{
    if(event.sender.id!==window.webContents.id || !refreshId || result?.id!==refreshId) return;
    if(result.error) {finishRefresh(true);return;}
    if(result.mode==='reload' && pending.size===0) window.webContents.reload();
    else finishRefresh();
  });
  ipcMain.handle('hellodog:translate', async (event, request: unknown) => {
    if (event.sender.id !== window.webContents.id) throw new Error('Invalid Signal window');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('翻译等待超时，消息未发送。原请求已保留，可重试原消息。')); }, 45000);
      pending.set(id, {resolve,reject,timer});
      process.send?.({channel:'hellodog',type:'translate',id,request});
    });
  });
  ipcMain.handle('hellodog:voice', async (event, request: any) => {
    if (event.sender.id !== senderId || event.senderFrame !== window.webContents.mainFrame || !process.connected) throw new Error('Signal 语音窗口已断开。');
    if (voicePending.size || typeof request?.audioBase64 !== 'string' || request.audioBase64.length > 12800064) throw new Error('语音正在处理或超过大小限制，请稍后重试。');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const fail = () => { const task = pending.get(id); if (!task) return; clearTimeout(task.timer); pending.delete(id); voicePending.delete(id); reject(new Error('语音翻译尚未完成，请稍后重试。')); };
      const timer = setTimeout(fail, 300000);
      pending.set(id, { resolve, reject, timer }); voicePending.add(id);
      process.send?.({ channel: 'hellodog', type: 'voice', id, request }, error => { if (error) fail(); });
    });
  });
  ipcMain.on('hellodog:conversation', (event, context: unknown) => { if(event.sender.id===window.webContents.id) process.send?.({channel:'hellodog',type:'conversation',context}); });
  ipcMain.on('hellodog:connection', (event, state: unknown) => { if(event.sender.id===window.webContents.id) process.send?.({channel:'hellodog',type:'connection',state}); });
  ipcMain.on('hellodog:health', (event, health: any) => {
    if(event.sender.id!==window.webContents.id)return;
    const processes=app.getAppMetrics();
    process.send?.({channel:'hellodog',type:'health',view:health.view,pending:health.pending,metrics:{
      cpuPercent:processes.reduce((sum,item)=>sum+item.cpu.percentCPUUsage,0),
      memoryMiB:processes.reduce((sum,item)=>sum+item.memory.workingSetSize,0)/1024,processCount:processes.length,
    }});
  });
  process.on('message', (raw: any) => {
    if(raw?.channel!=='hellodog') return;
    if(raw.type==='translation'||raw.type==='voice-result') { const item=pending.get(raw.id); if(item && (raw.type==='voice-result')===voicePending.has(raw.id)) { clearTimeout(item.timer); pending.delete(raw.id); voicePending.delete(raw.id); if(raw.error) item.reject(new Error(raw.error)); else item.resolve(raw.result); } }
    if(raw.type==='focus') window.webContents.focus();
    if(raw.type==='insert-draft' && typeof raw.id==='string' && typeof raw.text==='string' && raw.text.length<=2000) {
      quickReplyId=raw.id;window.webContents.send('hellodog:insert-draft',{id:raw.id,text:raw.text});
    }
    if(raw.type==='visibility') { if(raw.visible) window.showInactive(); else window.hide(); }
    if(raw.type==='refresh') window.webContents.send('hellodog:refresh');
    if(raw.type==='reload' && typeof raw.id==='string') {
      if(refreshId) finishRefresh(true);
      refreshId=raw.id;
      window.webContents.send('hellodog:reload',raw.id);
    }
    if(raw.type==='quit') app.quit();
    if(raw.type==='prepare-restart' && typeof raw.id==='string') {
      restartId=raw.id;window.webContents.send('hellodog:prepare-restart',raw.id);
    }
    if(raw.type==='inspect' && process.env.HELLODOG_TEST_HIDDEN==='1' && !app.isPackaged) {
      void (async()=>{const text=await window.webContents.executeJavaScript('document.body.innerText');const png=await window.webContents.capturePage();process.send?.({channel:'hellodog',type:'inspection',text,png:png.toPNG().toString('base64'),bounds:window.getBounds(),profile:app.getPath('userData')});})();
    }
  });
  process.once('disconnect', () => { for(const item of pending.values()) {clearTimeout(item.timer);item.reject(new Error('HelloDog closed'));} app.quit(); });
  window.once('ready-to-show', () => process.send?.({channel:'hellodog',type:'ready',version:app.getVersion(),handle:window.getNativeWindowHandle().readBigUInt64LE().toString(),pid:process.pid}));
}
