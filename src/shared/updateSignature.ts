import { createPublicKey, verify } from 'node:crypto'

export interface SignedUpdate {
  schemaVersion: 1; version: string; versionKey: string; sha256: string; size: number; channel: 'stable'|'beta'; notes: string
  issuedAt: string; expiresAt: string; sourceCommit?:string; signature: { algorithm: 'Ed25519'; keyId: string; value: string }
}
export interface UpdateTrust {
  keys: Record<string,string>; windowsPublisherSubjects: string[]
  /** Embedded release policy; a remote manifest cannot change this choice. */
  windowsInstallerPolicy?: 'authenticode' | 'signed-manifest'
}
export function updateSigningBytes(value: Omit<SignedUpdate,'signature'>): Buffer {
  return Buffer.from('HelloDog Update Manifest v1\0' + JSON.stringify([value.schemaVersion,value.version,value.versionKey,value.sha256,value.size,value.channel,value.notes,value.issuedAt,value.expiresAt,value.sourceCommit??null]),'utf8')
}
export function verifyUpdateSignature(raw: unknown, trust: UpdateTrust, now=Date.now()): SignedUpdate {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('更新签名信息无效。')
  const value=raw as SignedUpdate
  if(value.schemaVersion!==1 || !value.signature || value.signature.algorithm!=='Ed25519' ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(value.signature.keyId) || typeof value.signature.value!=='string' || !/^[A-Za-z0-9+/]{86}==$/.test(value.signature.value) ||
    !trust.keys[value.signature.keyId]) throw new Error('更新未通过官方签名验证，请稍后重试或前往官网。')
  const issued=Date.parse(value.issuedAt),expires=Date.parse(value.expiresAt)
  if(!Number.isFinite(issued)||!Number.isFinite(expires)||issued>now+5*60000||expires<=now||expires<=issued||expires-issued>120*86400000)throw new Error('更新签名已过期或时间无效，请重新检查。')
  if(typeof value.version!=='string'||typeof value.versionKey!=='string'||typeof value.sha256!=='string'||typeof value.notes!=='string'||value.notes.length>10000||
    !Number.isSafeInteger(value.size)||value.size<1||value.size>512*1024*1024||!['stable','beta'].includes(value.channel)||
    !/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(value.version)||!/^windows\/(?:beta\/)?v[\d.]+(?:-beta\.\d+)?\/[\w.\-]+\.exe$/.test(value.versionKey)||
    !value.versionKey.includes('/v'+value.version+'/')||!/^[a-f0-9]{64}$/.test(value.sha256)||
    (value.version.includes('-beta')?'beta':'stable')!==value.channel||value.sourceCommit!==undefined&&!/^[a-f0-9]{40}$/.test(value.sourceCommit))throw new Error('更新内容不完整。')
  try {
    const key=createPublicKey(trust.keys[value.signature.keyId])
    if(key.asymmetricKeyType!=='ed25519'||!verify(null,updateSigningBytes(value),key,Buffer.from(value.signature.value,'base64')))throw new Error()
  }catch{throw new Error('更新内容与官方签名不匹配，已阻止安装。')}
  return value
}
