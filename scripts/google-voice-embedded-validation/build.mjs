import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'
const root=fileURLToPath(new URL('../../',import.meta.url)),require=createRequire(resolve(root,'package.json'))
const viteRequire=createRequire(require.resolve('vite')),esbuild=viteRequire('esbuild')
await esbuild.build({entryPoints:[resolve(root,'src/main/platforms/googleVoice/embeddedViews.ts')],outfile:resolve(root,'verification/google-voice-embedded-research-20260920/prototype/embeddedViews.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron'],target:'node24'})
console.log('Embedded-view validation module built')
