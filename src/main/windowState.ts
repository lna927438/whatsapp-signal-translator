import { app, screen, type BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import { join } from 'path'
export type Rectangle = { x: number; y: number; width: number; height: number }
export function fitWindow(saved: Partial<Rectangle> | undefined, displays: Rectangle[]): Rectangle {
  const available = displays.length ? displays : [{x:0,y:0,width:1280,height:820}]
  const valid = saved && ['x','y','width','height'].every(key => Number.isFinite(saved[key as keyof Rectangle]))
  const match = valid && available.find(area => Math.min(area.x+area.width,saved!.x!+saved!.width!) - Math.max(area.x,saved!.x!) >= 80
    && Math.min(area.y+area.height,saved!.y!+saved!.height!) - Math.max(area.y,saved!.y!) >= 80)
  const area = match || available[0]
  const width = Math.min(area.width, Math.max(640, valid ? saved!.width! : 1280))
  const height = Math.min(area.height, Math.max(400, valid ? saved!.height! : 820))
  return { x: Math.round(match ? Math.max(area.x,Math.min(saved!.x!,area.x+area.width-width)) : area.x+(area.width-width)/2),
    y: Math.round(match ? Math.max(area.y,Math.min(saved!.y!,area.y+area.height-height)) : area.y+(area.height-height)/2), width, height }
}
const path = () => join(app.getPath('userData'),'window-state-v1.json')
export function restoreWindowState() {
  let saved: any
  try { saved = JSON.parse(readFileSync(path(),'utf8')) } catch {}
  return { ...fitWindow(saved,screen.getAllDisplays().map(display=>display.workArea)), maximized: saved?.maximized === true }
}
export function trackWindowState(window: BrowserWindow) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const save = () => {
    clearTimeout(timer)
    if (window.isDestroyed()) return
    try {
      mkdirSync(app.getPath('userData'),{recursive:true})
      writeFileSync(path()+'.tmp',JSON.stringify({...window.getNormalBounds(),maximized:window.isMaximized()}))
      renameSync(path()+'.tmp',path())
    } catch { /* Geometry is optional; recovery journals are saved separately. */ }
  }
  const schedule = () => { clearTimeout(timer); timer=setTimeout(save,300) }
  const recoverDisplay = () => { if(!window.isDestroyed()&&!window.isMaximized()) window.setBounds(fitWindow(window.getBounds(),screen.getAllDisplays().map(display=>display.workArea))) }
  window.on('move',schedule);window.on('resize',schedule);window.on('close',save)
  screen.on('display-removed',recoverDisplay)
  window.once('closed',()=>{clearTimeout(timer);screen.removeListener('display-removed',recoverDisplay)})
}
