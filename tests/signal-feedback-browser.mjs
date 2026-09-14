import {createRequire} from 'node:module'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(new URL('../package.json',import.meta.url))
const {build}=await import(pathToFileURL(require.resolve('vite')).href),vue=(await import(pathToFileURL(require.resolve('@vitejs/plugin-vue')).href)).default
const esbuild=createRequire(require.resolve('vite'))('esbuild')
const {_electron}=await import(pathToFileURL(process.env.HELLODOG_PLAYWRIGHT_PATH||'D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href)
const directory=join(root,'verification','signal-feedback-2026-09-14','browser-'+Date.now());await mkdir(directory,{recursive:true})
await build({configFile:false,root:join(root,'tests/browser-signal'),base:'./',plugins:[vue()],build:{outDir:join(directory,'renderer'),emptyOutDir:false},logLevel:'error'})
await esbuild.build({entryPoints:[join(root,'tests/browser-signal/main.ts')],bundle:true,platform:'node',format:'cjs',outfile:join(directory,'main.cjs'),external:['electron'],target:'node24'})
const electron=await _electron.launch({executablePath:join(root,'node_modules/electron/dist/electron.exe'),args:[join(directory,'main.cjs')],env:{...process.env,HELLODOG_QA_REPO:root,HELLODOG_QA_DIRECTORY:directory,HELLODOG_TEST_USER_DATA:join(directory,'profile')},timeout:30000})
const errors=[],checks=[]
try{
 const page=await electron.firstWindow();page.on('pageerror',error=>errors.push(error.message))
 await page.locator('.signal-contact').first().click();await page.locator('.msg').last().waitFor()
 const row=page.locator('.msg').filter({hasText:'A lovely afternoon'});await row.locator('.bubble>button').click()
 await row.locator('.translated').filter({hasText:'美好的下午'}).waitFor()
 const identity=await electron.evaluate(()=>globalThis.signalQa.manualCalls[0].identity)
 assert.deepEqual(Object.keys(identity).sort(),['account','fromMe','peer','timestamp']);checks.push('Reactive message translation through the real sandboxed preload and Electron IPC')
 await electron.evaluate(()=>{globalThis.signalQa.mode='auto'})
 await page.evaluate(()=>window.signalFixture.enableAuto())
 await page.locator('.msg').last().locator('.translated').filter({hasText:'明天见'}).waitFor({timeout:15000})
 assert.equal(await electron.evaluate(()=>globalThis.signalQa.autoAttempts),2);checks.push('Automatic delayed retry after a transient failure, without page refresh or a send')
 await page.locator('.signal-header-profile').click()
 await page.getByRole('button',{name:'媒体、链接和文件'}).click()
 await page.locator('.sg-grid img').first().waitFor()
 assert.equal(await page.locator('.sg-grid img').count(),3)
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('.sg-grid img')).every(image=>image.complete&&image.naturalWidth>0))
 await page.screenshot({path:join(directory,'album.png')})
 await page.locator('.sg-grid button').first().click()
 const viewer=page.locator('.signal-media-lightbox');await viewer.waitFor()
 const before=await viewer.locator('img').getAttribute('src');await viewer.getByRole('button',{name:'下一张',exact:true}).click()
 await page.waitForFunction(old=>document.querySelector('.signal-media-lightbox img')?.getAttribute('src')!==old,before)
 await electron.evaluate(()=>globalThis.signalQa.prepareClipboard())
 await viewer.getByRole('button',{name:'复制图片',exact:true}).click();await viewer.locator('.smv-status').filter({hasText:'图片已复制'}).waitFor()
 const copied=await electron.evaluate(()=>globalThis.signalQa.checkClipboard());assert.match(copied,/^[a-f0-9]{64}$/)
 await viewer.getByRole('button',{name:'保存附件',exact:true}).click();await viewer.locator('.smv-status').filter({hasText:'附件已保存'}).waitFor()
 const saved=await readFile(join(directory,'downloads','saved-photo.png'));assert.deepEqual(saved,await readFile(await electron.evaluate(()=>globalThis.signalQa.savedSource)))
 assert.equal(await electron.evaluate(()=>globalThis.signalQa.savedPixelHash()),copied)
 await viewer.locator('img').click({button:'right'});await viewer.locator('.smv-status').filter({hasText:'图片已复制'}).waitFor()
 assert.deepEqual(await electron.evaluate(()=>globalThis.signalQa.menuItems),['复制图片','保存附件'])
 checks.push('Real Windows image clipboard, lossless saved PNG and cloneable media IPC responses')
 await page.screenshot({path:join(directory,'viewer.png')})
 await page.keyboard.press('Escape');await viewer.waitFor({state:'detached'})
 await page.getByRole('tab',{name:/链接/}).click();assert.equal(await page.locator('.sg-link').count(),1)
 await page.getByRole('tab',{name:/文件/}).click();assert.equal(await page.locator('.sg-file').count(),1)
 checks.push('Thumbnail album, previous/next, keyboard close, links and file tabs')
 for(const width of [980,1360]){await electron.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,900),width);await page.getByRole('tab',{name:/媒体/}).click();await page.screenshot({path:join(directory,'album-'+width+'.png')});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);assert.ok(await page.evaluate(()=>document.querySelector('.signal-conversation').getBoundingClientRect().right<=document.querySelector('.signal-details').getBoundingClientRect().left+1))}
 await electron.evaluate(()=>{globalThis.signalQa.owner='other-owner'})
 const denied=await page.evaluate(()=>window.desktopAPI.signalMediaAction('fixture-signal','+12025550999','photo-one','copy').then(()=>false,()=>true));assert.ok(denied)
 const network=await electron.evaluate(()=>globalThis.signalQa.network);assert.deepEqual(network,[]);assert.deepEqual(errors,[])
 checks.push('Isolated fixture with no external network requests, recipient mismatch rejected and no renderer exceptions')
 await writeFile(join(directory,'results.json'),JSON.stringify({passed:true,checks,errors,directory,limitations:['Menu choices and save-dialog selection are automated fixtures; no real Signal messages or calls were sent.']},null,2))
 console.log(JSON.stringify({passed:true,checks,directory}))
}finally{
 await electron.evaluate(()=>globalThis.signalQa.restoreClipboard()).catch(()=>{})
 await electron.close()
}
