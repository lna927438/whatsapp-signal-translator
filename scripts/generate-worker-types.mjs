import {execFileSync} from 'node:child_process'
import {readFile,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../',import.meta.url))
const output=new URL('../server/worker/worker-configuration.d.ts',import.meta.url)
execFileSync(process.execPath,['website/node_modules/wrangler/bin/wrangler.js','types','--config','server/worker/wrangler.jsonc','--env-interface','SecurityWorkerBindings','--include-runtime','true','--strict-vars','false','server/worker/worker-configuration.d.ts'],{cwd:root,stdio:'pipe',windowsHide:true})
// Keep generated Worker platform definitions scoped to this module. They must not
// replace the DOM/Node globals used by the Electron renderer and regression tools.
await writeFile(output,(await readFile(output,'utf8'))+'\nexport type { SecurityWorkerBindings, ScheduledController };\n')
console.log('Worker bindings generated and scoped to their module.')
