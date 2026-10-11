import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const ts = require('typescript')
const options = Object.fromEntries(process.argv.slice(2).map(value => { const index=value.indexOf('='); return [value.slice(0,index),value.slice(index+1)] }))
for (const required of ['--playwright','--browser','--native-css','--output']) assert.ok(options[required], `Missing ${required}=...`)
const { chromium } = require(resolve(options['--playwright']))
const output = resolve(options['--output'])
await mkdir(output,{recursive:true})
const css = await readFile(resolve(options['--native-css']),'utf8')
const modules = {}
for(const name of ['hellodog.preload.ts','hellodog.voice.preload.ts','hellodog.voice.dom.ts']) {
  const source = await readFile(join(root,'integrations/hellodog-source',name),'utf8')
  modules[name]=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
}
const longChinese='下午好，感谢你发来这条语音。明天的会议我们可以安排在下午三点，先确认设计稿，再一起检查翻译结果和附件。请保留原来的语音，等你方便时再回复就好。这里是一段较长的中文译文，用来检查窄窗口自动换行后，每一行都有足够的高度，按钮、提示和后面的消息不会相互遮挡。'
const audio = `<div class="module-message__audio-attachment module-message__audio-attachment--incoming">
  <div class="module-message__audio-attachment__button-and-waveform"><button class="fixture-play" aria-label="播放原语音">▶</button><div class="fixture-wave" aria-label="18 秒语音波形">${Array.from({length:29},(_,i)=>`<i style="height:${7+(i*19)%27}px"></i>`).join('')}</div></div>
  <div class="module-message__audio-attachment__metadata"><span class="fixture-duration">0:18</span><span>10:28</span></div>
</div>`
function message(id) { return `<article class="fixture-message"><div class="fixture-label">${id==='success'?'较长中文译文':'失败后可手动重试'}</div><div class="module-message module-message--incoming" data-hellodog-id="${id}"><div class="module-message__container-outer"><div class="module-message__container module-message__container--incoming"><div dir="ltr">${audio}</div></div></div></div></article>` }
const browser = await chromium.launch({executablePath:resolve(options['--browser']),headless:true})
const reports=[]
try {
  for (const [name,width] of [['narrow',414],['wide',1000]]) {
    const context=await browser.newContext({viewport:{width,height:1000},deviceScaleFactor:1,locale:'zh-CN'})
    const page=await context.newPage()
    // No account/profile, remote service, ASR, playback, or sending is involved.
    const externalRequests=[]
    await page.route('**/*',route=>{externalRequests.push(route.request().url());return route.abort()})
    await page.setContent(`<html lang="zh-CN"><head><meta charset="utf-8"></head><body><main class="fixture-root module-timeline--width-${width<600?'narrow':'wide'}"><header><strong>Signal 语音翻译</strong><small>本地合成界面 · 18 秒语音 · ${width}px</small></header>${message('success')}${message('failure')}<footer>原语音保留 · 点击才翻译 · 不会自动发送</footer></main></body></html>`)
    await page.addStyleTag({content:css})
    await page.addStyleTag({content:`html,body{height:auto!important;min-height:100%;margin:0;background:#f4f6f8;color:#20262d;font-family:"Segoe UI","Microsoft YaHei",sans-serif}.fixture-root{max-width:820px;margin:0 auto;padding:28px 0 32px}header,footer,.fixture-label{padding:0 16px}header{margin-bottom:26px}header strong{display:block;font-size:22px}header small{display:block;margin-top:8px;color:#64717d;font-size:13px}.fixture-message{margin:0 0 26px}.fixture-label{color:#697784;font-size:12px;margin-bottom:6px}.fixture-play{border:0;border-radius:50%;width:36px;height:36px;background:#cbd5df;color:#33485a;margin-right:12px;font-size:17px;line-height:36px;padding:0;flex-shrink:0}.fixture-wave{display:flex;align-items:center;gap:3px;height:36px;min-width:0}.fixture-wave i{display:block;background:#839bb0;width:3px;border-radius:2px}.module-message__audio-attachment__metadata{font-size:12px;line-height:18px;color:#708090}.module-message__container--incoming{background:#e4eaf0;color:#20262d}footer{font-size:12px;color:#778590;line-height:1.6}`})
    await page.evaluate(({modules,longChinese})=>{
      const diagnostics=window.fixtureDiagnostics={reads:0,voiceCalls:0,textCalls:0,plays:0,removed:0}
      const originals=window.fixturePanels={}
      const messages=new Map(['success','failure'].map(id=>{
        const attributes={id,body:'',type:'incoming',conversationId:'fixture',attachments:[{contentType:'audio/ogg',path:id,size:100,clientUuid:id}]}
        return [id,{attributes,get:name=>attributes[name]}]
      }))
      window.MessageCache={getById:id=>messages.get(id)}
      window.ConversationController={get:()=>({getTitle:()=> 'Local fixture',get:()=> 'private'})}
      window.reduxStore={getState:()=>({selectedConversationId:'fixture'})}
      document.querySelectorAll('.fixture-play').forEach(button=>button.onclick=()=>diagnostics.plays++)
      new MutationObserver(records=>{
        for(const record of records)for(const node of record.removedNodes)if(node.matches?.('[data-hellodog-voice]'))diagnostics.removed++
      }).observe(document.body,{subtree:true,childList:true})
      const ipcRenderer={send:()=>{},on:()=>{},invoke:async(channel,request)=>{
        if(channel==='hellodog:voice'){
          diagnostics.voiceCalls++
          if(request.id==='failure')throw Error('Synthetic recognition failure')
          return {text:'Synthetic transcript',englishTranslation:'Good afternoon. Thank you for sending this voice message. We can schedule tomorrow’s meeting for three in the afternoon, confirm the design first, and then review translations and attachments together. Please keep the original voice message and reply whenever it is convenient.',translation:longChinese,audioId:'b'.repeat(64),targetLanguage:'zh-CN'}
        }
        diagnostics.textCalls++;throw Error('Unexpected text translation')
      }}
      const exportsByName={}
      function load(name){
        if(exportsByName[name])return exportsByName[name]
        const exports=exportsByName[name]={}
        const require=path=>{
          if(path==='electron')return {ipcRenderer}
          if(path==='node:crypto')return {createHash:()=>({update(){return this},digest:()=> 'a'.repeat(64)})}
          if(path==='node:buffer')return {Buffer:{from:()=>({toString:()=> 'fixture-base64'})}}
          if(path.includes('/migrations.'))return {loadAttachmentData:async()=>{diagnostics.reads++;return {data:new Uint8Array([1,2,3])}}}
          if(path.includes('/nav.'))return {getSelectedConversationId:state=>state.selectedConversationId}
          if(path.includes('voice-audio'))return {voiceAudioWav:async()=>new Uint8Array([1,2,3])}
          if(['./hellodog.voice.preload.ts','./hellodog.voice.dom.ts'].includes(path))return load(path.slice(2))
          return {}
        }
        new Function('exports','require','process',modules[name])(exports,require,{env:{HELLODOG_EMBEDDED:'1',HELLODOG_BRIDGE_ACTIVE:'1'}})
        return exports
      }
      load('hellodog.preload.ts').startHelloDogMessages()
      for(const id of messages.keys())originals[id]=document.querySelector(`[data-hellodog-id="${id}"] [data-hellodog-voice]`)
    },{modules,longChinese})
    await page.waitForTimeout(4500)
    assert.deepEqual(await page.evaluate(()=>window.fixtureDiagnostics),{reads:0,voiceCalls:0,textCalls:0,plays:0,removed:0})
    await page.locator('[data-hellodog-id="success"] [data-hellodog-voice] button').click()
    await page.locator('[data-hellodog-id="failure"] [data-hellodog-voice] button').click()
    await page.waitForFunction(()=>document.querySelector('[data-hellodog-id="success"] [lang="zh-CN"]')?.textContent.startsWith('下午好')&&document.querySelector('[data-hellodog-id="failure"] [data-hellodog-voice] button')?.textContent==='重试语音翻译')
    await page.evaluate(()=>{document.querySelector('.fixture-duration').textContent='0:18';document.dispatchEvent(new Event('scroll'))})
    await page.waitForTimeout(5500)
    const measurement=await page.evaluate(()=>{
      const rect=node=>{const b=node.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom}}
      const rows=['success','failure'].map(id=>{
        const row=document.querySelector(`[data-hellodog-id="${id}"]`),panel=row.querySelector('[data-hellodog-voice]'),status=panel.querySelector('[lang="zh-CN"]')||panel.querySelector('[role="status"]'),range=document.createRange()
        range.selectNodeContents(status)
        const english=panel.querySelector('[lang=en]')
        return {id,samePanel:panel===window.fixturePanels[id],audio:rect(row.querySelector('.module-message__audio-attachment')),bubble:rect(row.querySelector('.module-message__container')),panel:rect(panel),button:rect(panel.querySelector('button')),buttonHidden:panel.querySelector('button').hidden,status:rect(status),english:english?rect(english):null,lineHeight:getComputedStyle(status).lineHeight,statusScrollWidth:status.scrollWidth,statusClientWidth:status.clientWidth,lines:[...range.getClientRects()].map(b=>({y:b.y,bottom:b.bottom,height:b.height})),text:status.textContent}
      })
      return {diagnostics:window.fixtureDiagnostics,rows}
    })
    assert.deepEqual(measurement.diagnostics,{reads:2,voiceCalls:2,textCalls:0,plays:0,removed:0})
    for(const row of measurement.rows){
      assert.ok(row.samePanel,`${name}/${row.id}: panel replaced during observer scans`)
      assert.ok(row.panel.y>=row.audio.bottom-1,`${name}/${row.id}: panel overlaps audio`)
      assert.ok(row.status.y>=row.button.bottom-1,`${name}/${row.id}: status overlaps button`)
      assert.ok(row.status.bottom<=row.panel.bottom+1,`${name}/${row.id}: status exceeds panel`)
      assert.ok(row.panel.bottom<=row.bubble.bottom+1,`${name}/${row.id}: panel exceeds bubble`)
      if(!row.buttonHidden)assert.ok(row.button.x>=row.panel.x&&row.button.right<=row.panel.right+1,`${name}/${row.id}: button outside panel`)
      if(row.english){assert.ok(row.english.bottom<=row.status.y+1,`${name}/${row.id}: languages overlap`);assert.ok(row.english.y>=row.audio.bottom-1,`${name}/${row.id}: English overlaps audio`)}
      assert.ok(row.statusScrollWidth<=row.statusClientWidth+1,`${name}/${row.id}: horizontal text overflow`)
      assert.ok(parseFloat(row.lineHeight)>=19,`${name}/${row.id}: zero/small inherited line-height`)
      for(let i=1;i<row.lines.length;i++)assert.ok(row.lines[i].y>=row.lines[i-1].bottom-1,`${name}/${row.id}: wrapped text lines overlap`)
    }
    assert.ok(measurement.rows[0].lines.length>=4,'long Chinese fixture must exercise multiple wrapped lines')
    const screenshot=join(output,`signal-voice-${name}.png`)
    await page.screenshot({path:screenshot,fullPage:true})
    reports.push({viewport:{width,height:1000},name,screenshot,...measurement,externalRequestsBlocked:externalRequests.length})
    await context.close()
  }
} finally { await browser.close() }
const report={passed:true,css:resolve(options['--native-css']),browser:resolve(options['--browser']),stabilityMilliseconds:10000,syntheticAudio:true,realAccounts:false,reports}
await writeFile(join(output,'signal-voice-layout-report.json'),JSON.stringify(report,null,2))
console.log(JSON.stringify({passed:true,output,screenshots:reports.map(value=>value.screenshot),measurements:reports.map(({name,rows,diagnostics})=>({name,diagnostics,rows:rows.map(({id,lineHeight,lines,panel})=>({id,lineHeight,lineCount:lines.length,panelHeight:panel.height}))}))},null,2))
