import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
const root=new URL('../',import.meta.url)
const policy=JSON.parse(await readFile(new URL('security/release-policy.json',root),'utf8'))
const pkg=JSON.parse(await readFile(new URL('package.json',root),'utf8'))
if(process.argv.includes('--local')){
  console.log(JSON.stringify({productionAllowed:policy.allowProduction,version:pkg.version,localOnly:true}))
}else{
  if(policy.allowProduction!==true)throw new Error('Production publishing is blocked: '+(policy.reason||'Local builds and tests are allowed.'))
  const trust=JSON.parse(await readFile(new URL('resources/security/update-trust.json',root),'utf8'))
  if(!process.argv.includes('--web')){
    if(policy.requireSignedManifest!==true||!Object.keys(trust.keys||{}).length)throw new Error('Production update signing identity is not configured.')
    if(policy.requireSignedInstaller!==false){
      if(trust.windowsInstallerPolicy==='signed-manifest'||!trust.windowsPublisherSubjects?.length)throw new Error('Windows publisher signing is required by release policy.')
    }else if(policy.ownerAuthorizedProduction!==true||trust.windowsInstallerPolicy!=='signed-manifest')throw new Error('Unsigned Windows release requires explicit owner authorization and signed-manifest verification.')
  }
  if(!/^\d+\.\d+\.\d+$/.test(pkg.version))throw new Error('A stable version is required for public publishing.')
  if(policy.requireCleanSource&&execFileSync('git',['status','--porcelain','--untracked-files=normal'],{cwd:root,encoding:'utf8'}).trim())throw new Error('Commit and review the complete release source before publishing.')
  console.log('Release preconditions passed. This command does not publish.')
}
