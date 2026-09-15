import {readFile,readdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
const root=fileURLToPath(new URL('../',import.meta.url)),manifest=JSON.parse(await readFile(join(root,'resources/voice/manifest.json'),'utf8'))
const directory=join(root,'resources/voice/bin'),actual=(await readdir(directory)).sort(),expected=Object.keys(manifest.files).sort()
if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('Voice resource file set does not match the pinned manifest')
for(const name of expected){const hash=createHash('sha256').update(await readFile(join(directory,name))).digest('hex');if(hash!==manifest.files[name])throw Error('Voice resource checksum mismatch: '+name)}
for(const name of ['LICENSE-whisper.txt','LICENSE-whisper-cpp.txt'])if(!(await readFile(join(root,'resources/voice',name),'utf8')).includes('MIT'))throw Error('Missing voice resource license')
console.log(JSON.stringify({voiceResourcesVerified:true,files:expected.length,model:manifest.model}))
