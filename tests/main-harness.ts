import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
const require = createRequire(import.meta.url)
export function mainHarness(electronOverride?: any) {
  const directory = mkdtempSync(resolve(tmpdir(), 'hellodog-test-'))
  const modules = new Map<string, any>()
  function load(file: string): any {
    const path = resolve(file.endsWith('.ts') ? file : file + '.ts')
    if (modules.has(path)) return modules.get(path)
    const exports: any = {}; modules.set(path, exports)
    const code = ts.transpileModule(readFileSync(path,'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    runInNewContext(code, { exports, __dirname: dirname(path), Buffer, process, URL, Date, structuredClone, setTimeout, clearTimeout, AbortSignal, fetch: () => { throw new Error('Network forbidden in regression harness') }, require(name: string) {
      if (name === 'electron') return electronOverride || { app: { getPath: () => directory }, safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() } }
      if (name.startsWith('.')) return load(resolve(dirname(path), name))
      return require(name)
    } })
    return exports
  }
  return { load: (file: string) => load(new URL('../' + file, import.meta.url).pathname), directory }
}
