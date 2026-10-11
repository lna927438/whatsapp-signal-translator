import { pathToFileURL } from 'url'
import { join } from 'path'

export function externalUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return null
  try {
    const url = new URL(value)
    if (url.username || url.password) return null
    if (['https:', 'http:'].includes(url.protocol) && url.hostname) return url.href
    // Mail links may address a person, but cannot inject headers or attachments.
    if (url.protocol === 'mailto:' && !url.search && !url.hash && /^[^\s?<>]+@[^\s?<>]+$/.test(url.pathname)) return url.href
  } catch { /* Invalid URLs never reach the operating system. */ }
  return null
}

export function isWhatsAppUrl(value: string): boolean {
  try { const u = new URL(value); return u.origin === 'https://web.whatsapp.com' && !u.username && !u.password } catch { return false }
}

/** Only Telegram Web A receives our isolated chat bridge. Web K and external links do not. */
export function isTelegramUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.origin === 'https://web.telegram.org' && !u.username && !u.password
      && (u.pathname === '/a' || u.pathname.startsWith('/a/'))
  } catch { return false }
}

export function isTelegramOrigin(value: string): boolean {
  try { const u = new URL(value); return u.origin === 'https://web.telegram.org' && !u.username && !u.password } catch { return false }
}

export function isAppUrl(value: string, rendererDirectory: string, devUrl?: string): boolean {
  try {
    const candidate = new URL(value)
    if (devUrl) {
      const dev = new URL(devUrl)
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(dev.hostname) || dev.protocol !== 'http:') return false
      return candidate.origin === dev.origin && ['/', '/index.html', '/notification.html'].includes(candidate.pathname)
    }
    return ['index.html', 'notification.html'].some(name => candidate.protocol === 'file:' && candidate.origin === 'null' &&
      candidate.pathname === new URL(pathToFileURL(join(rendererDirectory, name)).href).pathname && !candidate.host)
  } catch { return false }
}

export function mainFrame(event: { senderFrame?: unknown; sender: { mainFrame?: unknown } }): boolean {
  return Boolean(event.senderFrame && event.sender.mainFrame && event.senderFrame === event.sender.mainFrame)
}
