import { join } from 'path'
/** Brand changes must not create a second account/session directory. */
export function legacyUserDataPath(appData: string, current: string, exists: (path: string) => boolean): string {
  const candidates = [join(appData, 'WhatsApp Signal Translator'), join(appData, 'whatsapp-signal-translator'), current]
  return candidates.find(path => ['accounts.json', 'settings.sec', 'Local Storage', 'outgoing-tasks-v1.json'].some(file => exists(join(path, file)))) || join(appData, 'whatsapp-signal-translator')
}
