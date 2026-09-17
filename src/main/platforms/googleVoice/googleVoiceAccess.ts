import { createHash } from 'crypto'
import { join } from 'path'
import { GoogleVoiceOfficialWindow } from './officialWindow'

type Identity = { owner: string; authorized: () => boolean }
type Launcher = Pick<GoogleVoiceOfficialWindow, 'open'>

/** Browser profiles follow HelloDog's data location and stay separate per owner. */
export function createGoogleVoiceAccess(
  userData: string,
  identity: () => Identity,
  createLauncher: (profileRoot: string) => Launcher = root => new GoogleVoiceOfficialWindow(root)
): () => ReturnType<Launcher['open']> {
  const launchers = new Map<string, Launcher>()
  return () => {
    const active = identity()
    if (!active.owner || !active.authorized()) throw new Error('请先登录 HelloDog。')
    const key = createHash('sha256').update(active.owner).digest('hex')
    let launcher = launchers.get(key)
    if (!launcher) {
      launcher = createLauncher(join(userData, 'google-voice', key))
      launchers.set(key, launcher)
    }
    return launcher.open(active.authorized)
  }
}
