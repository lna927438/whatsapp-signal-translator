import { access, chmod, copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { root, requireMacArm64, run, sha256 } from './macos-build-common.mjs'

requireMacArm64()
const cache = join(root, 'verification/macos-resources'), voice = join(root, 'resources/voice/bin-macos-arm64')
await mkdir(cache, { recursive: true }); await mkdir(voice, { recursive: true })
const whisper = { repository: 'https://github.com/ggml-org/whisper.cpp.git', tag: 'v1.9.2', commit: '306c88f4d1286aec1bf96e544632897886af5501' }
const source = join(cache, 'whisper.cpp')
if (!await access(source).then(() => true, () => false)) await run('git', ['clone', '--depth', '1', '--branch', whisper.tag, whisper.repository, source])
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim() !== whisper.commit) throw new Error('Whisper source differs from its reviewed pin.')
await run('cmake', ['-S', source, '-B', join(source, 'build'), '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_OSX_ARCHITECTURES=arm64', '-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0', '-DBUILD_SHARED_LIBS=OFF', '-DGGML_METAL=OFF', '-DGGML_BLAS=OFF', '-DGGML_OPENMP=OFF', '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_EXAMPLES=ON'])
await run('cmake', ['--build', join(source, 'build'), '--config', 'Release', '--target', 'whisper-cli', '-j', '3'])
const executable = join(voice, 'whisper-cli')
await copyFile(join(source, 'build/bin/whisper-cli'), executable); await chmod(executable, 0o755)
const linked = execFileSync('otool', ['-L', executable], { encoding: 'utf8' }).split('\n').slice(1).filter(Boolean)
if (linked.some(line => !/^\s*\/(?:usr\/lib|System\/Library)\//.test(line))) throw new Error('Whisper is not self-contained: unexpected dynamic library dependency.')
await run('codesign', ['--force', '--sign', '-', '--timestamp=none', executable])
await run('codesign', ['--verify', '--strict', executable])
const model = 'ggml-base.bin', modelHash = '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe', modelPath = join(voice, model)
const localModel = join(root, 'resources/voice/bin', model)
if (!await access(modelPath).then(() => true, () => false)) {
  if (await access(localModel).then(() => true, () => false)) {
    if (await sha256(localModel) !== modelHash) throw new Error('Local voice model checksum mismatch.')
    await copyFile(localModel, modelPath)
  } else {
    const partial = modelPath + '.partial'
    const response = await fetch('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin', { signal: AbortSignal.timeout(300000) })
    if (!response.ok || !response.body) throw new Error('Pinned voice model download failed.')
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
    if (await sha256(partial) !== modelHash) throw new Error('Downloaded voice model checksum mismatch.')
    await rename(partial, modelPath)
  }
}
if (await sha256(modelPath) !== modelHash) throw new Error('Voice model checksum mismatch.')
if ((await readdir(voice)).sort().join('|') !== [model, 'whisper-cli'].sort().join('|')) throw new Error('Unexpected files in Mac voice resource directory.')
const sample = join(source, 'samples/jfk.wav'), speechOutput = join(cache, 'jfk-recognition')
await run(executable, ['-m', modelPath, '-f', sample, '-l', 'en', '-t', '2', '-ng', '-oj', '-of', speechOutput, '-np'])
const sampleResult = JSON.parse(await readFile(speechOutput + '.json', 'utf8'))
const sampleText = (sampleResult.transcription || []).map(item => item.text || '').join(' ').trim()
if (!/ask\s+not/i.test(sampleText) || !/country/i.test(sampleText)) throw new Error('Native voice smoke did not transcribe the pinned public JFK sample correctly.')
await writeFile(join(cache, 'WHISPER-SMOKE.json'), JSON.stringify({ passed: true, platform: 'darwin', arch: 'arm64', sourceCommit: whisper.commit, sampleSha256: await sha256(sample), modelSha256: modelHash, expectedSpeechRecognized: true }, null, 2) + '\n')
// The checkout is ephemeral on CI. Hash after signing; packaging must preserve these exact bytes.
await writeFile(join(root, 'resources/voice/manifest.json'), JSON.stringify({ version: 'whisper.cpp-v1.9.2', platform: 'darwin', arch: 'arm64', source: `${whisper.repository.replace(/\.git$/, '')}/tree/${whisper.commit}`, modelSource: 'https://huggingface.co/ggerganov/whisper.cpp', executable: 'whisper-cli', model, files: { [model]: modelHash, 'whisper-cli': await sha256(executable) } }, null, 2) + '\n')

const lock = JSON.parse(await readFile(join(root, 'integrations/signal-desktop.lock.json'), 'utf8')), checkout = join(root, 'integrations/signal-desktop')
if (!await access(checkout).then(() => true, () => false)) await run('git', ['clone', '--depth', '1', '--branch', lock.tag, lock.repository, checkout])
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim() !== lock.commit) throw new Error('Signal source differs from reviewed source lock.')
await run(process.execPath, ['scripts/apply-signal-security.mjs'])
await run(process.execPath, ['scripts/macos-dependency-policy.mjs', 'signal'])
await run('pnpm', ['install', '--frozen-lockfile'], { cwd: checkout })
await run(process.execPath, ['scripts/verify-signal-security.mjs', '--source-only'])
await run(process.execPath, ['scripts/patch-signal-desktop.mjs'])
await run('pnpm', ['generate'], { cwd: checkout })
const upstream = JSON.parse(await readFile(join(checkout, 'package.json'), 'utf8'))
const signalConfig = { ...upstream.build, productName: 'Signal', directories: { ...upstream.build.directories, output: 'release/hellodog-macos-arm64' }, npmRebuild: false, publish: null, afterSign: null, artifactBuildCompleted: null, afterAllArtifactBuild: null, mac: { ...upstream.build.mac, icon: join(root, 'resources/brand/hellodog-icon.png'), target: [{ target: 'dir', arch: ['arm64'] }], identity: '-', sign: null, signInstaller: null, notarize: false, publish: null } }
const configPath = join(cache, 'signal-builder.json')
await writeFile(configPath, JSON.stringify(signalConfig, null, 2))
await run('pnpm', ['exec', 'electron-builder', '--config', configPath, '--mac', '--arm64', '--dir', '--publish', 'never'], { cwd: checkout, env: { ...process.env, SIGNAL_ENV: 'production', CSC_IDENTITY_AUTO_DISCOVERY: 'false', SKIP_SIGNING_SCRIPT: '1' } })
const signalApp = join(checkout, 'release/hellodog-macos-arm64/mac-arm64/Signal.app')
await run('codesign', ['--verify', '--deep', '--strict', signalApp])
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
const sourceNotice = (await readFile(join(root, 'integrations/notices/SOURCE.template.txt'), 'utf8')).replaceAll('{version}', version).replace(`HelloDog-${version}-corresponding-source.zip`, `HelloDog-${version}-mac-arm64-preview-corresponding-source.zip`).replace('Checksums are in delivery-manifest.json for local candidates, or\nrelease-manifest.json for published installers.', 'Checksums are in SHA256SUMS.txt and MAC-BUILD.json for this Mac acceptance build.')
await writeFile(join(root, 'integrations/notices/SOURCE.txt'), sourceNotice)
console.log(JSON.stringify({ prepared: true, platform: 'darwin', arch: 'arm64', signalCommit: lock.commit, whisperCommit: whisper.commit, modelSha256: modelHash }))
