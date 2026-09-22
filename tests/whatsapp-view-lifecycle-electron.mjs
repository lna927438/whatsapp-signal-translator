// Exercises the real adapter and native child views with local synthetic pages only.
// The fixture replaces navigation, proxy/security policy and translation injection;
// it intentionally does not claim live WhatsApp, proxy or translation coverage.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(resolve(root, 'package.json'))
const esbuild = createRequire(require.resolve('vite'))('esbuild')
const output = resolve(root, 'verification/whatsapp-view-lifecycle-20260923')
await mkdir(output, { recursive: true })
const adapterPath = resolve(root, 'src/main/platforms/whatsapp/whatsAppAdapter.ts')
const source = await readFile(adapterPath, 'utf8')
const sourceSha256 = createHash('sha256').update(source).digest('hex')
const replaceOnce = (text, before, after) => {
  if (text.split(before).length !== 2) throw new Error('Fixture adaptation changed: ' + before)
  return text.replace(before, after)
}
const adaptedSource = replaceOnce(replaceOnce(source,
  "contents.loadURL('https://web.whatsapp.com/'", 'contents.loadURL(globalThis.__fixtureUrlFor(accountId)'),
  "join(__dirname, '../preload/whatsapp.js')", 'globalThis.__fixturePreload')
const injection = `window.__RT_SEND_COMMIT__=()=>({dispatched:false});window.__RT_SEND_SELECT__=()=>false;window.__RT_APPLY_SETTINGS__=()=>true;window.__RT_SAVE_WORKSPACE__=()=>{window.__fixtureSaveCount=(window.__fixtureSaveCount||0)+1;return window.__fixtureSaveState||{}};window.__RT_RESUME_TRANSLATIONS__=()=>true;true`
await esbuild.build({
  bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'],
  entryPoints: [adapterPath], outfile: resolve(output, 'adapter.cjs'),
  plugins: [{ name: 'local-lifecycle-fixture', setup(build) {
    build.onLoad({ filter: /[\\/]whatsAppAdapter\.ts$/ }, () => ({ contents: adaptedSource, loader: 'ts', resolveDir: resolve(root, 'src/main/platforms/whatsapp') }))
    build.onLoad({ filter: /[\\/]accountProxy\.ts$/ }, () => ({ contents: 'export const configureProxySession=async(session)=>globalThis.__configureFixtureSession(session);export const normalizeProxy=value=>value||{enabled:false};export const proxyAuthMatches=()=>false;', loader: 'js' }))
    build.onLoad({ filter: /[\\/]webSecurity\.ts$/ }, () => ({ contents: 'export const installWebSecurity=()=>{};', loader: 'js' }))
    build.onLoad({ filter: /[\\/]whatsapp[\\/]inject[\\/]script\.ts$/ }, () => ({ contents: `export const whatsappInjectionScript=${JSON.stringify(injection)};`, loader: 'js' }))
    build.onLoad({ filter: /[\\/]whatsapp[\\/]contextMenu\.ts$/ }, () => ({ contents: 'export const whatsAppContextMenu=()=>[];', loader: 'js' }))
  } }]
})
await writeFile(resolve(output, 'view-preload.cjs'), "// Deliberately empty synthetic-page preload.\n")
await writeFile(resolve(output, 'shell-preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');const events=[];ipcRenderer.on('ui:account-action',(_event,value)=>events.push(value));contextBridge.exposeInMainWorld('fixtureEvents',()=>JSON.parse(JSON.stringify(events)));`)

const runtime = String.raw`
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const {join}=require('node:path');
const {mkdtempSync,writeFileSync}=require('node:fs');
const {createServer}=require('node:http');
const output=process.argv[2],runId=process.argv[3],sourceSha256=process.argv[4];
const profile=mkdtempSync('D:/UserAppData/Temp/hellodog-wa-lifecycle-');
app.setPath('userData',profile);app.setPath('crashDumps',join(profile,'crashes'));
app.on('window-all-closed',()=>{});
const checks=[],failures=[],requests=[],externalRequests=[],nativeEvents=[];
const heldImages=[],heldDocuments=[];
let shell,adapter,server,baseUrl,releaseDocuments=false;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,label,ms=9000){const end=Date.now()+ms;while(Date.now()<end){if(await predicate())return;await pause(30)}throw new Error('Timed out: '+label)}
const page=(label,image=false)=>'<!doctype html><meta charset="utf-8"><title>Local lifecycle fixture</title><style>body{background:#142126;color:#ebf5f3;font:18px sans-serif;padding:32px}main{background:#29433e;padding:24px;border-radius:12px}</style><main>'+label+'</main>'+(image?'<img src="/held-image" alt="delayed local resource">':'');
const respond=(response,label,image=false)=>{response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});response.end(page(label,image))};
const state=async id=>(await shell.webContents.executeJavaScript('window.fixtureEvents()')).filter(value=>value.accountId===id).at(-1)?.action;
const view=id=>shell.contentView.children.find(value=>value.webContents===adapter.contents(id));
const ready=async id=>await state(id)==='page-ready'&&view(id)?.getVisible();
const fail=error=>{failures.push(String(error?.stack||error));console.error(error?.stack||error)};
function observe(id){const wc=adapter.contents(id);wc.on('dom-ready',()=>nativeEvents.push({accountId:id,event:'dom-ready',at:Date.now()}));wc.on('did-finish-load',()=>nativeEvents.push({accountId:id,event:'did-finish-load',at:Date.now()}));wc.on('render-process-gone',(_event,details)=>nativeEvents.push({accountId:id,event:'render-process-gone',reason:details.reason,at:Date.now()}));wc.on('preload-error',(_event,_path,error)=>fail(error));return wc}
const report=passed=>({runId,at:new Date().toISOString(),passed,sourceSha256,checks,failures,nativeEvents,requests,externalRequests,electron:process.versions.electron,realAdapter:true,realWebContentsView:true,realRendererCrash:true,realShellStateIpc:true,hiddenMainWindow:!shell?.isVisible(),isolatedProfile:profile,externalNetwork:false,realAccounts:false,realMessages:false,realCharges:false,fixtureReplacements:['navigation target','proxy configuration','navigation security policy','translation injection','context menu','chat preload']});
async function cleanup(){try{adapter?.resetViews();if(shell&&!shell.isDestroyed())shell.destroy()}catch{}for(const response of [...heldImages,...heldDocuments])if(!response.writableEnded)response.destroy();server?.closeAllConnections();server?.close()}
app.whenReady().then(async()=>{
  server=createServer((request,response)=>{requests.push(request.url);if(request.url==='/held-image'){heldImages.push(response);return}if(request.url==='/slow'&&!releaseDocuments){heldDocuments.push(response);return}respond(response,request.url,request.url==='/early')});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  baseUrl='http://127.0.0.1:'+server.address().port;
  globalThis.__fixturePreload=join(output,'view-preload.cjs');
  globalThis.__fixtureUrlFor=id=>baseUrl+'/'+id;
  globalThis.__configureFixtureSession=async session=>{session.webRequest.onBeforeRequest((details,callback)=>{const allowed=details.url.startsWith(baseUrl+'/')||details.url==='about:blank'||details.url.startsWith('data:');if(!allowed)externalRequests.push(details.url);callback({cancel:!allowed})});await session.setProxy({mode:'direct'})};
  const {WhatsAppAdapter}=require(join(output,'adapter.cjs'));
  shell=new BrowserWindow({show:false,width:1080,height:780,webPreferences:{preload:join(output,'shell-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  await shell.loadURL('data:text/html,<title>Isolated lifecycle shell</title><main>Local synthetic fixture</main>');
  assert.equal(shell.isVisible(),false);
  adapter=new WhatsAppAdapter();adapter.attachMainWindow(shell);adapter.setContentBounds({x:90,y:76,width:940,height:640});

  const start=Date.now();assert.deepEqual(await adapter.focus('early'),{state:'loading'});const early=observe('early');
  assert.ok(Date.now()-start<1000,'Selection returns before the local page finishes loading');
  await until(()=>ready('early'),'early DOM ready view');
  assert.ok(heldImages.length>0);assert.equal(early.isLoading(),true);
  assert.equal(nativeEvents.filter(value=>value.accountId==='early'&&value.event==='did-finish-load').length,0);
  assert.equal(view('early').getVisible(),true);assert.ok(view('early').getBounds().width>0);
  checks.push('A real native child view is visible on dom-ready while a held resource still prevents did-finish-load');
  for(const response of heldImages){response.writeHead(204);response.end()}
  await until(()=>nativeEvents.some(value=>value.accountId==='early'&&value.event==='did-finish-load'),'early load finished after resource release');
  assert.equal(await early.executeJavaScript('document.querySelector("main").textContent'),'/early');

  adapter.setOverlayOpen(true);assert.equal(view('early').getVisible(),false);
  adapter.setOverlayOpen(false);assert.equal(view('early').getVisible(),true);
  adapter.hideAll();assert.equal(view('early').getVisible(),false);
  assert.deepEqual(await adapter.focus('early'),{state:'ready'});assert.equal(view('early').getVisible(),true);
  checks.push('Opening and closing an overlay, then hiding and selecting a ready account, restores the same real native child view');

  adapter.setOverlayOpen(true);await adapter.focus('fast');const fast=observe('fast');
  await until(async()=>await state('fast')==='page-ready','background DOM ready under overlay');
  assert.equal(view('fast').getVisible(),false);assert.equal(view('early').getVisible(),false);
  adapter.setOverlayOpen(false);assert.equal(view('fast').getVisible(),true);assert.equal(view('early').getVisible(),false);
  checks.push('A page that becomes ready beneath the overlay stays hidden until the overlay closes, without revealing another account');

  await adapter.focus('slow');observe('slow');await until(()=>heldDocuments.length>0,'delayed document requested');
  assert.equal(view('slow').getVisible(),false);await adapter.focus('fast');assert.equal(view('fast').getVisible(),true);
  releaseDocuments=true;for(const response of heldDocuments)respond(response,'/slow');
  await until(async()=>await state('slow')==='page-ready','stale page ready');
  assert.equal(view('slow').getVisible(),false);assert.equal(view('fast').getVisible(),true);assert.equal(adapter.activeId,'fast');
  checks.push('A previous account finishing its real delayed navigation cannot replace or reveal over the currently selected account');

  await until(()=>fast.executeJavaScript('typeof window.__RT_SAVE_WORKSPACE__==="function"'),'synthetic draft guard installed');
  const beforeHealthy=requests.filter(value=>value==='/fast').length;
  await fast.executeJavaScript('window.__fixtureSaveState={editing:true};true');
  await assert.rejects(adapter.reload('fast'),/正在处理消息/);assert.equal(requests.filter(value=>value==='/fast').length,beforeHealthy);assert.equal(view('fast').getVisible(),true);
  await fast.executeJavaScript('window.__fixtureSaveState={media:true};true');
  await assert.rejects(adapter.reload('fast'),/通话、录音或处理附件/);assert.equal(requests.filter(value=>value==='/fast').length,beforeHealthy);
  checks.push('Healthy real pages with a draft-editing or media guard are not navigated by Refresh');

  const oldWebContentsId=fast.id,oldProcessId=fast.getOSProcessId();
  fast.forcefullyCrashRenderer();
  await until(async()=>fast.isCrashed()&&await state('fast')==='page-failed','actual crash state');
  assert.equal(view('fast').getVisible(),false);
  await adapter.reload('fast');await until(()=>ready('fast'),'crashed renderer refreshed');
  assert.equal(adapter.contents('fast').id,oldWebContentsId);assert.equal(fast.isCrashed(),false);assert.notEqual(fast.getOSProcessId(),oldProcessId);
  assert.equal(await fast.executeJavaScript('document.querySelector("main").textContent'),'/fast');
  assert.ok(requests.filter(value=>value==='/fast').length>beforeHealthy);
  checks.push('An actual crashed Chromium renderer reports failure and Refresh restores the same account WebContents with a new working renderer');

  await until(()=>fast.executeJavaScript('typeof window.__RT_SAVE_WORKSPACE__==="function"'),'recovered draft guard installed');
  const beforeReload=requests.filter(value=>value==='/fast').length;
  await adapter.reload('fast');await until(()=>ready('fast'),'healthy refresh ready');
  assert.equal(requests.filter(value=>value==='/fast').length,beforeReload+1);assert.equal(adapter.activeId,'fast');
  checks.push('A healthy guarded refresh performs one navigation and returns the same selected account to ready');

  assert.deepEqual(externalRequests,[]);assert.equal(shell.isVisible(),false);assert.deepEqual(failures,[]);
  checks.push('Every synthetic account stayed within the isolated D-drive profile and localhost; the host window stayed hidden');
  const result=report(true);await cleanup();writeFileSync(join(output,'results.json'),JSON.stringify(result,null,2));app.exit(0);
}).catch(async error=>{fail(error);const result=report(false);await cleanup();writeFileSync(join(output,'results.json'),JSON.stringify(result,null,2));app.exit(1)});
`
await writeFile(resolve(output, 'runner.cjs'), runtime)
const environment = { ...process.env, TEMP: 'D:/UserAppData/Temp', TMP: 'D:/UserAppData/Temp' }
delete environment.ELECTRON_RUN_AS_NODE
const runId = randomUUID()
const child = spawn(resolve(root, 'node_modules/electron/dist/electron.exe'), [resolve(output, 'runner.cjs'), output, runId, sourceSha256], { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
child.stdout.on('data', value => { log += value })
child.stderr.on('data', value => { log += value })
const timer = setTimeout(() => child.kill(), 55000)
const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
clearTimeout(timer)
await writeFile(resolve(output, 'electron.log'), log)
const result = await readFile(resolve(output, 'results.json'), 'utf8').then(JSON.parse).catch(() => null)
const passed = exitCode === 0 && result?.runId === runId && result?.sourceSha256 === sourceSha256 && result?.passed === true && result.checks.length === 8
console.log(JSON.stringify({ exitCode, passed, checks: result?.checks?.length, sourceSha256, evidence: output }))
if (!passed) console.log(log.slice(-8000))
process.exitCode = passed ? 0 : 1
