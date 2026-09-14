import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { writeFileSync,readFileSync,existsSync,readdirSync,rmSync } from 'node:fs'
import { mainHarness } from './main-harness.ts'
const content=Buffer.from('verified installer fixture '.repeat(600))
const digest=createHash('sha256').update(content).digest('hex')
test('interrupted downloads resume their exact byte range and verify final bytes before use',async()=>{
 const ranges:string[]=[];let interrupted=false,interruptedReply:import('node:http').ServerResponse|undefined
 const server=createServer((req,res)=>{
  ranges.push(req.headers.range||'')
  const start=Number(req.headers.range?.match(/bytes=(\d+)-/)?.[1]||0)
  if(!interrupted){interrupted=true;interruptedReply=res;res.writeHead(200,{'Content-Length':content.length});res.write(content.subarray(0,1000));return}
  res.writeHead(start?206:200,{'Content-Length':content.length-start,...(start?{'Content-Range':'bytes '+start+'-'+(content.length-1)+'/'+content.length}:{})});res.end(content.subarray(start))
 })
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 const h=mainHarness(undefined,globalThis.fetch)
 try{
  const {downloadVerified}=h.load('src/main/updates.ts');const path=h.directory+'/setup.exe'
  const url='http://127.0.0.1:'+(server.address() as any).port
  await assert.rejects(downloadVerified(url,path,{sha256:digest,size:content.length},(bytes:number)=>{if(bytes===1000)interruptedReply?.destroy()}))
  assert.equal(existsSync(path),false);assert.equal(readFileSync(path+'.part').length,1000)
  await downloadVerified(url,path,{sha256:digest,size:content.length})
  assert.deepEqual(ranges,['','bytes=1000-']);assert.deepEqual(readFileSync(path),content)
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(h.directory,{recursive:true,force:true})}
})
test('a server ignoring Range safely restarts; incorrect bytes never become an installer',async()=>{
 const h=mainHarness(undefined,async()=>new Response(content));try{
  const {downloadVerified}=h.load('src/main/updates.ts'),path=h.directory+'/setup.exe'
  writeFileSync(path+'.part',content.subarray(0,40))
  await downloadVerified('https://fixture.invalid',path,{sha256:digest,size:content.length})
  assert.deepEqual(readFileSync(path),content)
  await assert.rejects(downloadVerified('https://fixture.invalid',h.directory+'/bad.exe',{sha256:'0'.repeat(64),size:content.length}),/校验失败/)
  assert.equal(existsSync(h.directory+'/bad.exe'),false)
  assert.ok(readdirSync(h.directory).some(name=>name.includes('.invalid-')))
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})
test('incorrect Content-Range cannot append bytes and stable/beta manifests stay separate',async()=>{
 const h=mainHarness(undefined,async()=>new Response(content,{status:206,headers:{'Content-Range':'bytes 0-9/10'}}));try{
  const {downloadVerified,validateManifest}=h.load('src/main/updates.ts'),path=h.directory+'/range.exe'
  writeFileSync(path+'.part',content.subarray(0,40))
  await assert.rejects(downloadVerified('https://fixture.invalid',path,{sha256:digest,size:content.length}),/范围不一致/)
  assert.equal(readFileSync(path+'.part').length,40)
  const manifest={version:'0.5.2-beta.2',versionKey:'windows/beta/v0.5.2-beta.2/setup.exe',size:content.length,sha256:digest,notes:'测试说明'}
  assert.equal(validateManifest(manifest,'beta').channel,'beta')
  assert.throws(()=>validateManifest(manifest,'stable'))
  assert.throws(()=>validateManifest({...manifest,versionKey:'../setup.exe'},'beta'))
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})

test('update recovery copies and verifies the prior executable independently of settings and chat data',async()=>{
 const h=mainHarness();try{
  const {mkdirSync}=await import('node:fs');const source=h.directory+'/installed',root=h.directory+'/recovery'
  mkdirSync(source+'/resources',{recursive:true});writeFileSync(source+'/HelloDog.exe','old executable');writeFileSync(source+'/resources/app.asar','old app')
  const {createUpdateRecovery}=h.load('src/main/storage/updateRecovery.ts')
  const backup=await createUpdateRecovery(source,root,'HelloDog.exe','0.5.1')
  assert.equal(readFileSync(backup+'/files/HelloDog.exe','utf8'),'old executable')
  assert.ok(readFileSync(backup+'/Restore-HelloDog.ps1','utf8').includes('Get-FileHash'))
  assert.ok(readFileSync(backup+'/Restore-HelloDog.ps1','utf8').includes('Get-Process'))
  const manifest=JSON.parse(readFileSync(backup+'/recovery.json','utf8'))
  assert.equal(manifest.version,'0.5.1');assert.equal(Object.keys(manifest.hashes).length,2)
  await assert.rejects(createUpdateRecovery(source,source+'/nested','HelloDog.exe','0.5.1'),/重叠/)
  assert.equal(readFileSync(source+'/HelloDog.exe','utf8'),'old executable')
 }finally{rmSync(h.directory,{recursive:true,force:true})}
})
