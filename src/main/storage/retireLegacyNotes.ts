import { app } from 'electron'
import { lstat, unlink } from 'fs/promises'
import { join, resolve, dirname } from 'path'
import { AccountManager } from '../accounts/accountManager'

/** Only the retired feature's two exact local files; never walk profile trees. */
export async function retireLegacyNotes() {
  await new AccountManager().retireLegacyNotes()
  const root=resolve(app.getPath('userData'))
  for(const name of ['contact-notes-v1.json','contact-notes-v1.json.tmp']) {
    const file=resolve(join(root,name))
    if(dirname(file)!==root)throw new Error('备注清理位置无效。')
    try {const info=await lstat(file);if(info.isFile()&&!info.isSymbolicLink())await unlink(file)}
    catch(error:any){if(error?.code!=='ENOENT')throw error}
  }
}
