import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const root = fileURLToPath(new URL('../', import.meta.url)), require = createRequire(resolve(root, 'package.json'))
const esbuild = createRequire(require.resolve('vite'))('esbuild')
const output = resolve(root, 'verification/google-voice-network-20260920')
const runId = randomUUID()
await mkdir(output, { recursive: true })
const syntax = spawnSync(process.execPath, ['--check', resolve(root, 'tests/google-voice-network-electron.cjs')], { windowsHide: true, encoding: 'utf8' })
if (syntax.status !== 0) throw new Error('Invalid Electron network fixture: ' + syntax.stderr)
// Generate a disposable fixture identity; no real server key or Google login is used.
const certificate = `
import datetime, ipaddress, pathlib, sys
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
out = pathlib.Path(sys.argv[1]); key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'HelloDog synthetic proxy fixture')])
now = datetime.datetime.now(datetime.timezone.utc)
cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
 .serial_number(x509.random_serial_number()).not_valid_before(now-datetime.timedelta(minutes=5))
 .not_valid_after(now+datetime.timedelta(days=1))
 .add_extension(x509.SubjectAlternativeName([x509.DNSName('api.ipify.org'),x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]), critical=False)
 .sign(key,hashes.SHA256()))
(out/'fixture-key.pem').write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
(out/'fixture-cert.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
`
const environment = { ...process.env, TEMP: 'D:/UserAppData/Temp', TMP: 'D:/UserAppData/Temp' }; delete environment.ELECTRON_RUN_AS_NODE
const generated = spawnSync('D:/UserAppData/OpenAI/DevelopmentRuntime/codex-primary-runtime/dependencies/python/python.exe', ['-c', certificate, output], { env: environment, windowsHide: true, encoding: 'utf8' })
if (generated.status !== 0) throw new Error('Cannot generate disposable proxy fixture certificate: ' + generated.stderr)
await esbuild.build({ entryPoints: [resolve(root, 'src/main/platforms/googleVoice/network.ts')], outfile: resolve(output, 'network.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node24' })
await esbuild.build({ entryPoints: [resolve(root, 'src/main/network/accountProxy.ts')], outfile: resolve(output, 'accountProxy.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node24' })
const child = spawn(resolve(root, 'node_modules/electron/dist/electron.exe'), [resolve(root, 'tests/google-voice-network-electron.cjs'), output, runId], { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''; child.stdout.on('data', value => { log += value }); child.stderr.on('data', value => { log += value })
const timer = setTimeout(() => child.kill(), 60000)
const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
clearTimeout(timer); await writeFile(resolve(output, 'network-fixture.log'), log)
await unlink(resolve(output, 'fixture-key.pem'))
const result = exit === 0 ? JSON.parse(await readFile(resolve(output, 'results.json'), 'utf8')) : undefined
if (result && (result.runId !== runId || result.passed !== 7)) throw new Error('Electron fixture did not produce current complete evidence')
console.log(JSON.stringify({ exitCode: exit, passed: result?.passed, evidence: output })); if (exit !== 0) console.log(log.slice(-7500))
process.exitCode = exit ?? 1
