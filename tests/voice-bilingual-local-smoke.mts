import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { resolve, relative, join } from 'node:path'
import { mainHarness } from './main-harness.ts'

// Local synthetic speech only. No microphone, account, provider or chat send.
const root = resolve(import.meta.dirname, '..')
const source = readFileSync(join(root, 'tests/fixtures/voice-english-synthetic.wav'))
let pcm: Buffer | undefined
for (let at = 12; at + 8 <= source.length;) {
  const size = source.readUInt32LE(at + 4)
  if (source.toString('ascii', at, at + 4) === 'fmt ') {
    assert.equal(source.readUInt16LE(at + 8), 1); assert.equal(source.readUInt16LE(at + 10), 1)
    assert.equal(source.readUInt32LE(at + 12), 16000); assert.equal(source.readUInt16LE(at + 22), 16)
  }
  if (source.toString('ascii', at, at + 4) === 'data') pcm = source.subarray(at + 8, at + 8 + size)
  at += 8 + size + size % 2
}
assert.ok(pcm)
const bytes = Buffer.alloc(pcm.length + 44)
bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16)
bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28)
bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(pcm.length, 40); pcm.copy(bytes, 44)
const harness = mainHarness(undefined, undefined, {
  '../../../resources/voice/manifest.json': { default: JSON.parse(readFileSync(join(root, 'resources/voice/manifest.json'), 'utf8')) }
})
const temporary = join(harness.directory, 'asr')
const { VoiceRecognition } = harness.load('src/main/translation/voiceRecognition.ts')
const voice = new VoiceRecognition(join(root, 'resources/voice/bin'), temporary), started = Date.now()
try {
  const recognized = await voice.recognizeWithLanguage(bytes, () => true)
  assert.equal(recognized.language, 'en')
  assert.match(recognized.text, /call me tomorrow morning/i); assert.match(recognized.text, /station/i)
  assert.deepEqual(readdirSync(temporary), [])
  const result = { passed: true, language: recognized.language, transcript: recognized.text, elapsedMs: Date.now() - started,
    source: 'synthetic Microsoft Zira speech', realRecognizer: true, temporaryAudioRemoved: true, cloudRequests: 0, realChatSends: 0 }
  const evidence = join(root, 'verification/voice-release-20261012'); mkdirSync(evidence, { recursive: true })
  writeFileSync(join(evidence, 'local-asr-language.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
} finally {
  await voice.dispose()
  assert.match(relative(resolve(process.env.TEMP || ''), resolve(harness.directory)), /^hellodog-test-[a-zA-Z0-9]+$/)
  rmSync(harness.directory, { recursive: true, force: true })
}
