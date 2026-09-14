// NSIS cannot open some long pnpm paths after moving a checkout. Short aliases
// affect this build process only; dependencies and their contents stay intact.
if (process.platform === 'win32') {
  const fs = require('node:fs')
  const path = require('node:path')
  const { tmpdir } = require('node:os')
  const { createRequire } = require('node:module')
  const builder = createRequire(require.resolve('electron-builder'))
  const lib = createRequire(builder.resolve('app-builder-lib'))
  const manager = lib('./util/pathManager.js')
  const original = manager.getTemplatePath('nsis')
  if (path.join(original, 'include', 'allowOnlyOneInstallerInstance.nsh').length >= 240) {
    const root = path.dirname(path.dirname(original))
    const temporary = fs.mkdtempSync(path.join(tmpdir(), 'hellodog-build-'))
    const alias = path.join(temporary, 'builder')
    fs.symlinkSync(root, alias, 'junction')
    if (fs.realpathSync(alias).toLowerCase() !== fs.realpathSync(root).toLowerCase()) throw new Error('Build alias target mismatch')
    manager.getTemplatePath = file => path.join(alias, 'templates', file)
    manager.getVendorPath = file => file == null ? path.join(alias, 'vendor') : path.join(alias, 'vendor', file)
    process.on('exit', () => {
      // Remove only the junction and the empty directory made by this process.
      try { fs.unlinkSync(alias); fs.rmdirSync(temporary) } catch { /* Harmless temporary alias may be cleaned after Windows releases it. */ }
    })
  }
}
