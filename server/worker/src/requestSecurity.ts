export async function boundedJson(request: Request, maximum = 65536): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error('invalid_request')
  const declared = request.headers.get('content-length')
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new Error('invalid_request')
  const reader = request.body?.getReader()
  if (!reader) throw new Error('invalid_request')
  const chunks: Uint8Array[] = []; let length = 0
  try {
    while (true) {
      const value = await reader.read(); if (value.done) break
      length += value.value.byteLength
      if (length > maximum) { await reader.cancel(); throw new Error('invalid_request') }
      chunks.push(value.value)
    }
    const bytes = new Uint8Array(length); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch { throw new Error('invalid_request') } finally { reader.releaseLock() }
}
export async function rateKey(request: Request): Promise<string> {
  const ip = request.headers.get('CF-Connecting-IP') || 'local-no-edge-ip'
  const day = new Date().toISOString().slice(0, 10)
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(day + ':' + ip))
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')
}
export function providerTokenBounds(text: string, instructions: string) {
  const bytes = new TextEncoder().encode(text + instructions).byteLength
  // Conservative protection reservation, not a claim about billed Tokens.
  return { input: Math.min(262144, bytes + 4096), output: Math.min(16384, Math.max(1024, new TextEncoder().encode(text).byteLength * 2)) }
}
