import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto'
const magic=Buffer.from('HELLODOG-BACKUP-1\n')
function key(value:Buffer){if(value.length!==32)throw new Error('Backup encryption requires a separate 32-byte key.');return value}
export function encryptBackup(content:Uint8Array,secret:Buffer):Buffer{
  const iv=randomBytes(12),header=Buffer.concat([magic,iv]),cipher=createCipheriv('aes-256-gcm',key(secret),iv)
  cipher.setAAD(header)
  return Buffer.concat([header,cipher.update(content),cipher.final(),cipher.getAuthTag()])
}
export function decryptBackup(archive:Buffer,secret:Buffer):Buffer{
  if(archive.length<magic.length+28||!archive.subarray(0,magic.length).equals(magic))throw new Error('Invalid encrypted backup.')
  const header=archive.subarray(0,magic.length+12),decipher=createDecipheriv('aes-256-gcm',key(secret),header.subarray(magic.length))
  decipher.setAAD(header);decipher.setAuthTag(archive.subarray(-16))
  try{return Buffer.concat([decipher.update(archive.subarray(header.length,-16)),decipher.final()])}catch{throw new Error('Backup authentication failed; no restore was performed.')}
}
