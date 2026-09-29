import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { mainHarness } from './main-harness.ts'

// Synthetic Microsoft Zira speech only; no account, microphone, or provider.
// Run explicitly against a Unicode installation path as part of Windows QA.
const resourcesArg = process.argv.find(value => value.startsWith('--resources='))
assert.ok(resourcesArg, 'Pass the installed or extracted voice resources directory')
const resources = resolve(resourcesArg.slice('--resources='.length))
assert.match(resources, /[^\x00-\x7f]/, 'This regression must use a Unicode installation path')
const source = readFileSync(resolve('tests/fixtures/voice-english-synthetic.wav'))
let pcm: Buffer | undefined
for (let at = 12; at + 8 <= source.length;) {
  const size = source.readUInt32LE(at + 4)
  if (source.toString('ascii', at, at + 4) === 'data') pcm = source.subarray(at + 8, at + 8 + size)
  at += 8 + size + (size % 2)
}
assert.ok(pcm)
const bytes = Buffer.alloc(pcm.length + 44)
bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16)
bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28)
bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(pcm.length, 40); pcm.copy(bytes, 44)
const evidence = resolve('verification/signal-voice-fix-20260929')
mkdirSync(evidence, { recursive: true })
const temporary = resolve(evidence, 'unicode-install-recognition-temp')
const harness = mainHarness(undefined, undefined, {
  '../../../resources/voice/manifest.json': { default: JSON.parse(readFileSync(resolve('resources/voice/manifest.json'), 'utf8')) },
})
const { VoiceRecognition } = harness.load('src/main/translation/voiceRecognition.ts')
const start = Date.now()
const transcript = await new VoiceRecognition(resources, temporary).recognize(bytes, () => true)
assert.match(transcript, /call me tomorrow morning/i)
assert.match(transcript, /station/i)
assert.deepEqual(readdirSync(temporary), [])
const result = { passed: true, unicodeInstallation: true, elapsedMs: Date.now() - start,
  source: 'synthetic Microsoft Zira speech', transcript, temporaryAudioRemoved: true, cloudRequests: 0, realChatSends: 0 }
writeFileSync(resolve(evidence, 'unicode-install-smoke.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result))
