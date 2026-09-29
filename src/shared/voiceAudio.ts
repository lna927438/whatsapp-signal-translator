export const VOICE_MAX_SECONDS = 300
export const VOICE_SAMPLE_RATE = 16000
export const VOICE_MAX_BYTES = VOICE_MAX_SECONDS * VOICE_SAMPLE_RATE * 2 + 44

/** Decode only an already authorized media URL in its owning renderer. Main
 * accepts canonical PCM, never a renderer-provided filesystem path or URL. */
export async function voiceAudioWav(url: string): Promise<Uint8Array> {
  if (!/^(blob:|hellodog-media:)/.test(url)) throw new Error('请先在当前聊天中下载或播放语音，再点击翻译。')
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error('语音读取失败，请重新下载后重试。')
  if (Number(response.headers.get('content-length')) > 20 * 1024 * 1024) throw new Error('语音文件过大，请选择 5 分钟以内的语音。')
  const reader = response.body?.getReader(); if (!reader) throw new Error('无法读取语音。')
  const chunks: Uint8Array[] = []; let size = 0
  try { for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > 20 * 1024 * 1024) throw new Error('语音文件过大。'); chunks.push(item.value) } }
  finally { await reader.cancel().catch(() => undefined) }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  const decoder = new AudioContext()
  try {
    const decoded = await decoder.decodeAudioData(bytes.buffer)
    if (!Number.isFinite(decoded.duration) || decoded.duration < 0.1 || decoded.duration > 300) throw new Error('请选择 5 分钟以内的语音。')
    const count = Math.ceil(decoded.duration * 16000), offline = new OfflineAudioContext(1, count, 16000)
    const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start()
    const samples = (await offline.startRendering()).getChannelData(0), output = new Uint8Array(44 + count * 2), view = new DataView(output.buffer)
    const label = (at: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)) }
    label(0, 'RIFF'); view.setUint32(4, output.length - 8, true); label(8, 'WAVE'); label(12, 'fmt '); view.setUint32(16, 16, true)
    view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true)
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); label(36, 'data'); view.setUint32(40, count * 2, true)
    for (let i = 0; i < count; i++) { const value = samples[i] ?? 0; const sample = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0; view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true) }
    return output
  } finally { await decoder.close() }
}

export function validateVoiceWav(input: unknown): Uint8Array {
  if (!(input instanceof Uint8Array) || input.byteLength < 3244 || input.byteLength > VOICE_MAX_BYTES) throw new Error('语音数据无效或超过 5 分钟。')
  const bytes = new Uint8Array(input), view = new DataView(bytes.buffer)
  const label = (at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length))
  if (label(0,4) !== 'RIFF' || label(8,4) !== 'WAVE' || label(12,4) !== 'fmt ' || label(36,4) !== 'data'
    || view.getUint32(4,true) !== bytes.length - 8 || view.getUint32(16,true) !== 16 || view.getUint16(20,true) !== 1
    || view.getUint16(22,true) !== 1 || view.getUint32(24,true) !== 16000 || view.getUint32(28,true) !== 32000
    || view.getUint16(32,true) !== 2 || view.getUint16(34,true) !== 16 || view.getUint32(40,true) !== bytes.length - 44 || (bytes.length - 44) % 2) throw new Error('语音格式校验失败，请重新读取。')
  let peak = 0, energy = 0
  for (let i=44;i<bytes.length;i+=2) { const sample=view.getInt16(i,true)/32768; peak=Math.max(peak,Math.abs(sample));energy+=sample*sample }
  if (peak < 0.002 || Math.sqrt(energy / ((bytes.length - 44) / 2)) < 0.0003) throw new Error('没有识别到可听见的语音，请确认录音内容。')
  return bytes
}
