import { protocol } from 'electron'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { Readable } from 'stream'
import { randomUUID } from 'crypto'
import { byteRange, mediaKind } from '../../../shared/signalMedia'

type Access = { path: string; contentType: string; allowed: () => Promise<boolean>; expires: number }
const grants = new Map<string, Access>()
export function grantSignalMedia(path: string, contentType: string, allowed: Access['allowed']): string {
  if (mediaKind(contentType) === 'file') throw new Error('此类型文件请保存后查看。')
  const token = randomUUID()
  for (const [key, value] of grants) if (value.expires < Date.now()) grants.delete(key)
  grants.set(token, { path, contentType, allowed, expires: Date.now() + 60 * 60000 })
  return 'hellodog-media://media/' + token
}
export function clearSignalMediaGrants() { grants.clear() }
export function registerSignalMediaScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: 'hellodog-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])
}
export async function serveSignalMedia(request: Request): Promise<Response> {
  const url = new URL(request.url), access = url.hostname === 'media' ? grants.get(url.pathname.slice(1)) : undefined
  if (!['GET', 'HEAD'].includes(request.method) || !access || access.expires < Date.now() || !await access.allowed().catch(() => false)) return new Response(null, { status: 403 })
  try {
    const size = (await stat(access.path)).size, range = byteRange(request.headers.get('Range'), size)
    if (!range) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    const headers: Record<string,string> = { 'Content-Type': access.contentType, 'Content-Length': String(range.end - range.start + 1), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" }
    if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`
    const body = request.method === 'HEAD' || !size ? null : Readable.toWeb(createReadStream(access.path, { start: range.start, end: range.end })) as ReadableStream<Uint8Array>
    return new Response(body, { status: range.partial ? 206 : 200, headers })
  } catch { return new Response(null, { status: 404 }) }
}
export function installSignalMediaProtocol() { protocol.handle('hellodog-media', serveSignalMedia) }
