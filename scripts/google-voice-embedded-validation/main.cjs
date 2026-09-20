const {app,BrowserWindow,ipcMain,session}=require('electron')
const {join}=require('path')
const {mkdirSync,writeFileSync,appendFileSync}=require('fs')
const {pathToFileURL}=require('url')
const assert=require('assert/strict')
const evidence=join(__dirname,'../../verification/google-voice-embedded-research-20260920')
mkdirSync(evidence,{recursive:true})
const selfTest=process.argv.includes('--self-test'), inspectPublic=process.argv.includes('--inspect-public')
let blockedDiagnostic=()=>{}
const trace=value=>{if(selfTest||inspectPublic)appendFileSync(join(evidence,selfTest?'fixture-trace.log':'public-trace.log'),JSON.stringify(value)+'\n')}
if(selfTest||inspectPublic){process.on('uncaughtException',err=>{trace({uncaught:err.message,stack:err.stack});app.exit(1)});process.on('unhandledRejection',err=>{trace({unhandled:String(err)});app.exit(1)});setTimeout(()=>{trace({failed:'Prototype overall deadline'});app.exit(2)},45000).unref()}
const profile=join('D:/UserAppData/HelloDog/VoiceEmbedValidation-20260920',selfTest?'fixture-'+Date.now():inspectPublic?'public-'+Date.now():'interactive')
mkdirSync(profile,{recursive:true});app.setPath('userData',profile);app.setPath('sessionData',profile)
app.setName('HelloDogVoiceValidation')
const {GoogleVoiceEmbeddedViews}=require(join(evidence,'prototype/embeddedViews.cjs'))
let window,workspace,selected='',accounts=[],lastState,error=''
const owner='embed-validation-owner',fixtureRequests=[],fixtureRedirects=[],fixtureBlocked=[]
// Google Voice's own public Sign in link; this opens the official page, not an OAuth workaround.
const officialSignIn='https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Fvoice.google.com%2Flanding'
if(!selfTest&&!inspectPublic){if(!app.requestSingleInstanceLock())app.exit(0);blockedDiagnostic=require('./diagnostics.cjs').installDiagnostics(app,evidence);app.on('second-instance',()=>{if(window&&!window.isDestroyed()){window.restore();window.show();window.focus()}})}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(test,label,attempts=100){for(let i=0;i<attempts;i++){if(await test())return;await delay(100)}throw Error('Timeout: '+label)}
function snapshot(){return {selected,accounts,state:lastState,error}}
function emit(){if(window&&!window.isDestroyed())window.webContents.send('embed-prototype:state',snapshot())}
function allowed(event){if(event.sender!==window.webContents || event.senderFrame!==window.webContents.mainFrame || event.senderFrame.url!==pathToFileURL(join(__dirname,'shell.html')).href)throw Error('Only the prototype shell may manage views')}
function viewList(){return window.contentView.children.filter(view=>view.webContents&&view.webContents!==window.webContents&&!view.webContents.isDestroyed())}
function topView(){return viewList().filter(view=>view.getVisible()).at(-1)}
function layout(){if(!workspace||window.isDestroyed())return;const [width,height]=window.getContentSize();workspace.setBounds({x:0,y:142,width,height:Math.max(1,height-142)})}
async function add(){if(accounts.length>=4)return;const id='gv-00000000-0000-4000-8000-'+String(accounts.length+1).padStart(12,'0');accounts.push({id,label:'账号 '+(accounts.length+1)});selected=id;error='';emit();try{await workspace.create(owner,id);workspace.focus(owner,id);lastState=workspace.getState(owner,id);emit()}catch{error='官方页面暂时无法加载；没有切换到外部浏览器。可点击重新加载。';emit()}}
function fixture(request){
 const url=new URL(request.url)
 fixtureRequests.push({method:request.method,origin:url.origin,path:url.pathname})
 // Entirely synthetic completion chain: every session's HTTPS protocol is
 // intercepted below, so these regional sign-in URLs never reach Google.
 const completionRedirects={
  'https://accounts.google.com/verification-complete':'https://accounts.google.co.th/accounts/SetSID?fixture=synthetic-only',
  'https://accounts.google.co.th/accounts/SetSID':'https://accounts.google.co.uk/accounts/SetSID?fixture=synthetic-only',
  'https://accounts.google.co.uk/accounts/SetSID':'https://accounts.youtube.com/accounts/SetSID?fixture=synthetic-only',
  'https://accounts.youtube.com/accounts/SetSID':'https://voice.google.com/settled'
 }
 const next=completionRedirects[url.origin+url.pathname]
 if(next)return new Response(null,{status:302,headers:{location:next}})
 const isMain=url.hostname==='voice.google.com'
 return new Response(isMain?`<!doctype html><meta charset="utf-8"><h1>LOCAL FIXTURE · NOT GOOGLE</h1><button id="popup" onclick="window.open('https://accounts.google.com/embed-fixture','auth')">Popup</button><a id="link" href="https://accounts.google.com/link-fixture" target="_blank">Link popup</a><form id="post" target="_blank" action="https://accounts.google.com/post-fixture" method="POST"><input name="fixture" value="synthetic-only"><button>POST</button></form><button id="outside" onclick="window.open('https://example.invalid/blocked','out')">Unknown outside</button>`:`<!doctype html><meta charset="utf-8"><h1>LOCAL POPUP FIXTURE · NOT GOOGLE</h1>`,{headers:{'content-type':'text/html; charset=utf-8'}})
}
if(selfTest){const intercepted=new WeakSet();app.on('web-contents-created',(_event,wc)=>{
 wc.on('will-redirect',(event,value,_inPlace,isMain)=>{if(event.isMainFrame??isMain){const url=new URL(event.url||value);fixtureRedirects.push({webContents:wc,session:wc.session,origin:url.origin,path:url.pathname})}})
 if(intercepted.has(wc.session))return;intercepted.add(wc.session);wc.session.protocol.handle('https',fixture);wc.session.protocol.handle('http',()=>new Response('blocked',{status:403}))
})}
app.whenReady().then(async()=>{
 window=new BrowserWindow({width:1120,height:800,minWidth:760,minHeight:580,show:!selfTest&&!inspectPublic,title:'HelloDog · Google Voice 真正内嵌验证',backgroundColor:'#11191e',webPreferences:{preload:join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}})
 window.setMenu(null)
 workspace=new GoogleVoiceEmbeddedViews(window,{onState:state=>{if(inspectPublic)trace({status:state.status,origin:state.origin,popupDepth:state.popupDepth});if(state.windowId===selected){lastState=state;workspace?.setOverlayOpen(state.status==='failed');emit()}},onBlockedNavigation:event=>{if(selfTest)fixtureBlocked.push(event);blockedDiagnostic(event);if(inspectPublic)trace({blocked:event.reason,origin:event.origin});error=(event.reason==='navigation'?'页面跳转未在验证版中开放，当前页面仍留在客户端内。':'这个弹窗暂不兼容，当前页面仍留在客户端内。')+(event.origin?' 来源：'+event.origin:'');emit()}})
 window.on('resize',layout);window.on('closed',()=>{workspace.destroy();app.quit()})
 ipcMain.handle('embed-prototype:snapshot',event=>{allowed(event);return snapshot()})
 ipcMain.handle('embed-prototype:add',event=>{allowed(event);return add()})
 ipcMain.handle('embed-prototype:choose',(event,id)=>{allowed(event);if(!accounts.some(row=>row.id===id))throw Error('Unknown account');selected=id;error='';workspace.focus(owner,id);lastState=workspace.getState(owner,id);emit()})
 ipcMain.handle('embed-prototype:back',event=>{allowed(event);error='';workspace.back(owner,selected);lastState=workspace.getState(owner,selected);emit()})
 ipcMain.handle('embed-prototype:reload',event=>{allowed(event);error='';workspace.reload(owner,selected);emit()})
 ipcMain.handle('embed-prototype:signin',event=>{allowed(event);error='';workspace.setOverlayOpen(false);const view=topView();if(view)void view.webContents.loadURL(officialSignIn).catch(()=>{});emit()})
 await window.loadFile(join(__dirname,'shell.html'));layout();await add()
 if(selfTest){window.showInactive();await until(()=>workspace.getState(owner,selected).status==='ready','fixture load');await runSelfTest()}
 else if(inspectPublic)await inspectBeforeLogin()
}).catch(err=>{trace({failed:true,type:err.name,message:err.message,stack:err.stack});console.error(JSON.stringify({failed:true,type:err.name,message:err.message}));app.exit(1)})
async function inspectBeforeLogin(){
 await until(()=>['ready','failed'].includes(workspace.getState(owner,selected).status),'public page before login',300).catch(()=>trace({pageDeadline:true}));await delay(1000)
 const view=viewList().at(-1);assert.ok(view,'The public page must have an actual child view')
 const state=workspace.getState(owner,selected)
 if(state.origin==='https://workspace.google.com'){
  window.showInactive();await delay(800)
  writeFileSync(join(evidence,'public-before-login.png'),(await window.webContents.capturePage()).toPNG())
  writeFileSync(join(evidence,'public-page-only.png'),(await view.webContents.capturePage()).toPNG())
 }
 const result={at:new Date().toISOString(),browserWindowCount:BrowserWindow.getAllWindows().length,childViewCount:viewList().length,origin:state.origin,status:state.status,profileIsolated:true,defaultUserAgent:!view.webContents.getUserAgent().includes('Firefox'),googleLoginVerified:false,accountsEntered:false,scope:'Public page before entering any account. No cookie reads, no account input, no translation or calls.'}
 writeFileSync(join(evidence,'public-before-login.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));window.close()
}
async function runSelfTest(){
 trace({step:'begin'})
 const checks=[]
 assert.equal(BrowserWindow.getAllWindows().length,1);assert.equal(viewList().length,1);const first=topView();assert.ok(first);assert.equal(first.webContents.getLastWebPreferences().sandbox,true);assert.equal(first.webContents.getLastWebPreferences().nodeIntegration,false);checks.push('One parent BrowserWindow with a sandboxed actual child view')
 trace({step:'before JS popup'});await first.webContents.executeJavaScript("document.getElementById('popup').click()");trace({step:'after JS popup'})
 await until(()=>viewList().length===2&&topView()!==first,'in-place popup')
 const popup=topView();await until(()=>!popup.webContents.isLoading(),'popup load');assert.equal(BrowserWindow.getAllWindows().length,1);assert.equal(popup.webContents.session,first.webContents.session);assert.equal(await popup.webContents.executeJavaScript('Boolean(window.opener)'),true);checks.push('window.open retains opener and same session without an external BrowserWindow')
 workspace.back(owner,selected);await until(()=>viewList().length===1,'return from popup')
 trace({step:'before link'});await first.webContents.executeJavaScript("document.getElementById('link').click()");trace({step:'after link'})
 await until(()=>fixtureRequests.some(row=>row.path==='/link-fixture'),'target blank link navigation');assert.equal(BrowserWindow.getAllWindows().length,1);assert.equal(viewList().length,2);checks.push('A target=_blank link navigates inside the client instead of leaving a blank view')
 workspace.back(owner,selected);await until(()=>viewList().length===1,'return from target blank link')
 trace({step:'before POST'});await first.webContents.executeJavaScript("document.getElementById('post').requestSubmit()");trace({step:'after POST'})
 await until(()=>fixtureRequests.some(row=>row.path==='/post-fixture'),'POST popup')
 assert.equal(fixtureRequests.find(row=>row.path==='/post-fixture').method,'POST');assert.equal(BrowserWindow.getAllWindows().length,1);checks.push('POST popup stays internal and preserves its HTTP method')
 workspace.back(owner,selected);await until(()=>viewList().length===1,'return from POST popup')
 const redirectsBefore=fixtureRedirects.length,blockedBefore=fixtureBlocked.length
 await first.webContents.executeJavaScript("window.open('https://accounts.google.com/verification-complete','auth-complete');undefined")
 await until(()=>fixtureRequests.some(row=>row.origin==='https://voice.google.com'&&row.path==='/settled'),'Google regional account completion redirect chain')
 const completion=topView();await until(()=>!completion.webContents.isLoading(),'regional account completion final document')
 const expectedRedirects=[
  ['https://accounts.google.co.th','/accounts/SetSID'],
  ['https://accounts.google.co.uk','/accounts/SetSID'],
  ['https://accounts.youtube.com','/accounts/SetSID'],
  ['https://voice.google.com','/settled']
 ]
 const completionRedirects=fixtureRedirects.slice(redirectsBefore)
 assert.deepEqual(completionRedirects.map(row=>[row.origin,row.path]),expectedRedirects)
 for(const [origin,path] of expectedRedirects)assert.ok(fixtureRequests.some(row=>row.origin===origin&&row.path===path),'Synthetic completion target must be requested: '+origin+path)
 assert.equal(fixtureBlocked.length,blockedBefore,'Official regional completion redirects must not be blocked')
 assert.equal(BrowserWindow.getAllWindows().length,1);assert.equal(viewList().length,2)
 assert.equal(topView(),completion);assert.notEqual(completion,first);assert.equal(completion.webContents.getURL(),'https://voice.google.com/settled')
 assert.equal(completion.webContents.session,first.webContents.session)
 for(const row of completionRedirects){assert.equal(row.webContents,completion.webContents,'Every redirect must retain the same child view');assert.equal(row.session,first.webContents.session,'Every redirect must retain the same account session')}
 checks.push('Regional sign-in redirects through accounts.google.co.th, accounts.google.co.uk and accounts.youtube.com return to Voice in one child view and session without blocking')
 workspace.back(owner,selected);await until(()=>viewList().length===1,'return from completion redirect')
 await first.webContents.executeJavaScript("document.getElementById('outside').click()")
 await delay(150);assert.equal(viewList().length,1);assert.equal(BrowserWindow.getAllWindows().length,1);checks.push('Unknown external destination is blocked rather than opening a browser')
 error='';await add();await until(()=>workspace.getState(owner,selected).status==='ready','second fixture load');const second=topView();assert.notEqual(second,first);assert.notEqual(second.webContents.session,first.webContents.session);await first.webContents.session.cookies.set({url:'https://voice.google.com/',name:'fixture_isolation',value:'synthetic-only'});assert.equal((await second.webContents.session.cookies.get({url:'https://voice.google.com/',name:'fixture_isolation'})).length,0);checks.push('Independent account partitions do not share the synthetic test cookie')
 workspace.setOverlayOpen(true);assert.equal(viewList().filter(view=>view.getVisible()).length,0);workspace.setOverlayOpen(false);assert.equal(viewList().filter(view=>view.getVisible()).length,1);checks.push('Client overlay hides the remote view, then restores the selected account only')
 window.setContentSize(900,620);layout();assert.deepEqual(topView().getBounds(),{x:0,y:142,width:900,height:478});checks.push('Resize follows client content coordinates without a detached native pane')
 writeFileSync(join(evidence,'embedded-fixture.png'),(await window.webContents.capturePage()).toPNG());const result={at:new Date().toISOString(),passed:true,checks,realNetwork:false,realAccounts:false,realMessages:false};writeFileSync(join(evidence,'embedded-fixture.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));window.close()
}
