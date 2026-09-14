// Local output only. Credentials come from libpq environment, never command text.
import {spawn} from 'node:child_process'
import {readFile,writeFile,unlink,mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {resolve,join} from 'node:path'
import {encryptBackup,decryptBackup} from '../src/shared/backupEncryption.ts'
const args=process.argv.slice(2),value=name=>args[args.indexOf(name)+1]
const secret=Buffer.from(process.env.HELLODOG_BACKUP_KEY||'','base64')
if(secret.length!==32)throw new Error('Provide a separate 32-byte base64 backup key using the secure environment. Keep it outside the backup destination and repository.')
async function run(command,params,collect=false){
  return new Promise((resolve,reject)=>{const child=spawn(command,params,{env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe']});let size=0,chunks=[]
    child.stdout.on('data',chunk=>{if(!collect)return;size+=chunk.length;if(size>256*1024*1024){child.kill();reject(new Error('Backup exceeds the 256 MiB local tool limit. Use the managed backup procedure.'))}else chunks.push(chunk)})
    child.stderr.resume();child.on('error',()=>reject(new Error('PostgreSQL backup utility is unavailable.')));child.on('close',code=>code===0?resolve(Buffer.concat(chunks)):reject(new Error('PostgreSQL backup/restore failed. Credentials and server output are not printed.')))
  })
}
if(args.includes('--backup')){
  if(!process.env.PGHOST||!process.env.PGDATABASE||!value('--out'))throw new Error('Provide PGHOST, PGDATABASE and --out.')
  const dump=await run(process.env.HELLODOG_PG_DUMP||'pg_dump',['--format=custom','--no-owner','--no-password'],true)
  try{await writeFile(resolve(value('--out')),encryptBackup(dump,secret),{flag:'wx',mode:0o600})}finally{dump.fill(0);secret.fill(0)}
  console.log('Encrypted database backup saved locally. No cloud configuration was changed.')
}else if(args.includes('--restore-test')){
  if(!['127.0.0.1','::1','localhost'].includes(process.env.PGHOST)||!/^hellodog_restore_[a-z0-9_]+$/.test(process.env.PGDATABASE||''))throw new Error('Restore is restricted to a separately created local hellodog_restore_* database.')
  if(!value('--input'))throw new Error('--input is required.')
  const archive=await readFile(resolve(value('--input'))),dump=decryptBackup(archive,secret),dir=await mkdtemp(join(tmpdir(),'hellodog-restore-')),path=join(dir,'verified.dump')
  try{await writeFile(path,dump,{flag:'wx',mode:0o600});dump.fill(0);await run(process.env.HELLODOG_PG_RESTORE||'pg_restore',['--single-transaction','--exit-on-error','--no-owner','--no-password','--dbname',process.env.PGDATABASE,path])}finally{await unlink(path).catch(()=>{});dump.fill(0);secret.fill(0)}
  console.log('Restore into the dedicated local database completed. Compare balances, ledger totals and request IDs before considering the backup usable.')
}else throw new Error('Use --backup --out PATH or --restore-test --input PATH. This tool never overwrites existing backups or cleans a destination database.')
