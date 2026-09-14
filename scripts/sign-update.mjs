import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { updateSigningBytes, verifyUpdateSignature } from '../src/shared/updateSignature.ts'

const args=process.argv.slice(2)
const option=name=>args[args.indexOf(name)+1]
if(args.includes('--init-key')){
  const path=resolve(option('--init-key')),passphrase=process.env.HELLODOG_SIGNING_PASSPHRASE
  const location=relative(fileURLToPath(new URL('../',import.meta.url)),path)
  if(!location.startsWith('..')&&!isAbsolute(location))throw new Error('Private signing keys must be created outside the repository.')
  if(!passphrase||passphrase.length<20)throw new Error('Set a signing passphrase of at least 20 characters in the secure environment.')
  const pair=generateKeyPairSync('ed25519',{publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem',cipher:'aes-256-cbc',passphrase}})
  await mkdir(dirname(path),{recursive:true});await writeFile(path,pair.privateKey,{flag:'wx',mode:0o600});await writeFile(path+'.public.pem',pair.publicKey,{flag:'wx'})
  console.log('Encrypted signing key created. Store it outside the repository and configure only its public key in update-trust.json.')
}else{
  for(const name of ['--manifest','--installer','--key','--key-id','--out'])if(!args.includes(name)||!option(name))throw new Error('Required: --manifest --installer --key --key-id --out')
  const input=JSON.parse(await readFile(option('--manifest'),'utf8'))
  const hash=createHash('sha256');let size=0
  for await(const chunk of createReadStream(option('--installer'))){hash.update(chunk);size+=chunk.length}
  if(input.sha256!==hash.digest('hex')||input.size!==size)throw new Error('Installer and manifest do not match.')
  const key=createPrivateKey({key:await readFile(option('--key'),'utf8'),passphrase:process.env.HELLODOG_SIGNING_PASSPHRASE})
  if(key.asymmetricKeyType!=='ed25519')throw new Error('An Ed25519 release key is required.')
  const value={schemaVersion:1,version:input.version,versionKey:input.versionKey,sha256:input.sha256,size:input.size,channel:input.channel,notes:input.notes||'',issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+90*86400000).toISOString(),...(input.sourceCommit?{sourceCommit:input.sourceCommit}:{})}
  const keyId=option('--key-id'),signed={...value,signature:{algorithm:'Ed25519',keyId,value:sign(null,updateSigningBytes(value),key).toString('base64')}}
  verifyUpdateSignature(signed,{keys:{[keyId]:createPublicKey(key).export({type:'spki',format:'pem'})},windowsPublisherSubjects:[]})
  await writeFile(option('--out'),JSON.stringify({...signed,platform:'windows',latestKey:input.channel==='beta'?'windows/beta/latest/HelloDog-Setup.exe':'windows/latest/WhatsApp-Signal-Translator-Setup.exe'},null,2)+'\n',{flag:'wx'})
  console.log('Signed manifest created locally. Nothing was uploaded.')
}
