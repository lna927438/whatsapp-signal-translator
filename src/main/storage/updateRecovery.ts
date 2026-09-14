import { cp, mkdir, lstat, readdir, realpath, writeFile } from 'fs/promises'
import { join, resolve, relative, basename } from 'path'
import { randomUUID, createHash } from 'crypto'
import { createReadStream } from 'fs'
async function hash(path: string) { const value = createHash('sha256'); for await (const bytes of createReadStream(path)) value.update(bytes); return value.digest('hex') }
function inside(parent: string, child: string) { const path = relative(parent.toLowerCase(), child.toLowerCase()); return !path || (!path.startsWith('..') && !path.includes(':')) }
/** Snapshot executable files only. Chat sessions, credentials and drafts live outside this directory. */
export async function createUpdateRecovery(installation: string, recoveryRoot: string, executable: string, version: string) {
  const source = await realpath(installation), root = resolve(recoveryRoot)
  if (inside(source, root) || inside(root, source)) throw new Error('恢复目录不能与程序目录重叠。')
  if (basename(executable) !== executable || !/^[\w .-]+\.exe$/i.test(executable)) throw new Error('程序名称无效。')
  const verifyTree = async (path: string): Promise<void> => {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error('程序目录包含链接，无法创建可验证的恢复副本。')
    if (info.isDirectory()) for (const entry of await readdir(path)) await verifyTree(join(path, entry))
  }
  await verifyTree(source)
  const directory = join(root, 'previous-' + randomUUID()), files = join(directory, 'files')
  const paths = [executable, 'resources/app.asar']
  const hashes = Object.fromEntries(await Promise.all(paths.map(async path => [path, await hash(join(source, path))])))
  await mkdir(directory, { recursive: true })
  await cp(source, files, { recursive: true, force: false, errorOnExist: true })
  for (const path of paths) if (await hash(join(files, path)) !== hashes[path]) throw new Error('上一版程序副本校验失败，未启动安装。')
  await writeFile(join(directory, 'recovery.json'), JSON.stringify({ version, installation: source, executable, hashes }, null, 2), 'utf8')
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot "recovery.json") -Raw -Encoding UTF8 | ConvertFrom-Json',
    '$source = Join-Path $PSScriptRoot "files"',
    '$running = Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($manifest.executable)) -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq (Join-Path $manifest.installation $manifest.executable) }',
    'if ($running) { Write-Host "Please exit HelloDog before restoring."; Read-Host "Press Enter to close"; exit 1 }',
    'foreach ($entry in $manifest.hashes.PSObject.Properties) { if ((Get-FileHash -LiteralPath (Join-Path $source $entry.Name) -Algorithm SHA256).Hash.ToLower() -ne $entry.Value) { throw "Recovery files failed verification." } }',
    'New-Item -ItemType Directory -Path $manifest.installation -Force | Out-Null',
    'Get-ChildItem -LiteralPath $source -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $manifest.installation -Recurse -Force }',
    'Write-Host ("HelloDog " + $manifest.version + " restored. Your app data has not been changed.")',
    'Read-Host "Press Enter to close"'
  ].join('\r\n')
  await writeFile(join(directory, 'Restore-HelloDog.ps1'), script, 'utf8')
  await writeFile(join(directory, 'Restore-HelloDog.cmd'), '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Restore-HelloDog.ps1"\r\n', 'utf8')
  await writeFile(join(directory, '恢复说明.txt'), '此目录保存更新前的 HelloDog ' + version + ' 程序文件。\n若安装失败，请先退出 HelloDog，再双击 Restore-HelloDog.cmd。\n会覆盖程序文件，不删除登录、草稿、翻译记录或其他应用数据。若原安装位置需要管理员权限，请以管理员身份运行。\n请勿移动 files 文件夹或修改 recovery.json。\n', 'utf8')
  return directory
}
