// Local static UI. Authentication and every data operation go to the existing cloud service.
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {resolve,extname,sep} from 'node:path'
const root=fileURLToPath(new URL('../website/dist-admin-live/',import.meta.url))
const port=5174,origin=`http://127.0.0.1:${port}`
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.ico':'image/x-icon','.woff2':'font/woff2'}
createServer(async(req,res)=>{
  const headers={'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store',
    'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://api.hellodog.net https://iqxpliruaeuqklxdnybd.supabase.co; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"}
  const send=(status,body,type='text/plain; charset=utf-8')=>{res.writeHead(status,{...headers,'Content-Type':type});res.end(req.method==='HEAD'?'':body)}
  if(req.headers.host!==`127.0.0.1:${port}`)return send(403,'Forbidden host')
  if(!['GET','HEAD'].includes(req.method))return send(405,'Read-only UI host')
  try{
    const url=new URL(req.url,origin)
    if(url.pathname==='/__local/health')return send(200,JSON.stringify({service:'hellodog-admin-live',sampleData:false,api:'https://api.hellodog.net'}),'application/json')
    const path=decodeURIComponent(url.pathname),file=resolve(root,'.'+path)
    if(!file.startsWith(resolve(root)+sep))return send(404,'Not found')
    if(!extname(path))return send(200,await readFile(resolve(root,'index.html')),'text/html; charset=utf-8')
    if(!types[extname(path)])return send(404,'Not found')
    return send(200,await readFile(file),types[extname(path)])
  }catch{return send(404,'Not found')}
}).listen(port,'127.0.0.1',()=>process.stdout.write(`HelloDog admin: ${origin}/admin (real cloud data)\n`))
