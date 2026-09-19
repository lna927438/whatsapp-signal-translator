// Reports locations and rule names only. Never prints a matched credential.
import {execFileSync} from 'node:child_process'
import {readFile,readdir,stat} from 'node:fs/promises'
import {resolve,relative,extname} from 'node:path'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../',import.meta.url)),findings=[]
const textExtensions=new Set(['.ts','.js','.mjs','.cjs','.cs','.vue','.json','.yaml','.yml','.toml','.md','.html','.txt','.ps1','.sh','.sql','.env','.map'])
const git=args=>execFileSync('git',args,{cwd:root,maxBuffer:128*1024*1024,windowsHide:true})
function inspect(content,path){
  const text=content.toString('utf8');if(text.includes('\0'))return
  const rules=[['private-signing-key',/-----BEGIN (?:ENCRYPTED |RSA |EC |OPENSSH )?PRIVATE KEY-----/g],['provider-secret',/\b(?:sk-proj-|sk-ant-api\d+-|sb_secret_)[A-Za-z0-9_-]{24,}/g],['provider-key-literal',/\bsk-[A-Za-z0-9]{32,}\b/g],['github-secret',/\b(?:ghp_|github_pat_)[A-Za-z0-9_]{30,}/g]]
  for(const [rule,re] of rules)for(const match of text.matchAll(re))findings.push({path,rule,line:text.slice(0,match.index).split('\n').length})
  for(const match of text.matchAll(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g))try{const claims=JSON.parse(Buffer.from(match[0].split('.')[1],'base64url'));if(claims.role==='service_role')findings.push({path,rule:'supabase-service-role',line:text.slice(0,match.index).split('\n').length})}catch{}
}
let sourceFiles=0,buildFiles=0,historyBlobs=0
for(const file of git(['ls-files','-z']).toString().split('\0').filter(Boolean)){
  if(!textExtensions.has(extname(file))&&!file.endsWith('.env'))continue
  try{inspect(await readFile(resolve(root,file)),file);sourceFiles++}catch(e){if(e.code!=='ENOENT')throw e}
}
async function tree(dir){try{for(const entry of await readdir(dir,{withFileTypes:true})){const path=resolve(dir,entry.name);if(entry.isDirectory())await tree(path);else if(textExtensions.has(extname(path))&&(await stat(path)).size<32*1024*1024){inspect(await readFile(path),relative(root,path));buildFiles++}}}catch(e){if(e.code!=='ENOENT')throw e}}
for(const dir of ['src','server/worker/src','website/src','resources/security','resources/native','integrations/google-voice-extension','security','scripts','.github','supabase/migrations','out','website/dist'])await tree(resolve(root,dir))
if(!process.argv.includes('--no-history')){
  const ids=new Set(git(['rev-list','--objects','--all']).toString().split('\n').filter(Boolean).filter(line=>textExtensions.has(extname(line.slice(41)))).map(line=>line.slice(0,40)))
  for(const id of ids){const size=Number(git(['cat-file','-s',id]).toString());if(size>8*1024*1024)continue;inspect(git(['cat-file','blob',id]),'git-blob:'+id);historyBlobs++}
}
const unique=[...new Map(findings.map(f=>[`${f.path}:${f.line}:${f.rule}`,f])).values()]
console.log(JSON.stringify({scope:'Tracked source, current application source, build output, and available local Git history. Untracked credential files and remote-only history are excluded.',sourceFiles,buildFiles,historyBlobs,findings:unique,passed:!unique.length},null,2))
if(unique.length)process.exitCode=1
