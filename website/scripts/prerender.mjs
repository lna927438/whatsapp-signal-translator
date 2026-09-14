import {build} from 'vite'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
const root=fileURLToPath(new URL('../',import.meta.url)),dist=join(root,'dist'),ssr=join(root,'.prerender')
await build({root,build:{ssr:join(root,'src/entry-server.ts'),outDir:ssr,emptyOutDir:true},define:{'import.meta.env.VITE_SUPABASE_URL':'""','import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY':'""'}})
const {render,pageSeo,structuredData,siteOrigin,publicPages}=await import(pathToFileURL(join(ssr,'entry-server.js')).href)
const template=await readFile(join(dist,'index.html'),'utf8')
const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')
function document(path,body,prerender){
 const seo=pageSeo(path),schema=structuredData(path),url=siteOrigin+seo.path
 const extra=[`<meta name="robots" content="${seo.index?'index, follow':'noindex, nofollow'}">`,`<meta property="og:title" content="${escape(seo.title)}">`,`<meta property="og:description" content="${escape(seo.description)}">`,'<meta property="og:site_name" content="HelloDog">','<meta property="og:type" content="website">',`<meta property="og:image" content="${siteOrigin}/hellodog-icon.webp">`,...(seo.index?[`<link rel="canonical" href="${url}">`,`<meta property="og:url" content="${url}">`]:[]),...(schema?[`<script id="hellodog-schema" type="application/ld+json">${JSON.stringify(schema).replaceAll('<','\\u003c')}</script>`]:[])].join('\n    ')
 return template.replace(/<title>.*?<\/title>/s,'<title>'+escape(seo.title)+'</title>').replace(/<meta name="description"[^>]*>/,'<meta name="description" content="'+escape(seo.description)+'">').replace('</head>',extra+'\n</head>').replace('<div id="app"></div>',`<div id="app"${prerender?' data-prerender="true"':''}>${body}</div>`)
}
await mkdir(dist,{recursive:true});await writeFile(join(dist,'_app-shell.html'),document('/login','',false))
for(const {path,file}of publicPages){const body=await render(path);if(!body.includes('<h1')||!body.includes('HelloDog'))throw new Error('Prerendered content missing');await writeFile(join(dist,file),document(path,body,true));console.log('Public page prerendered: '+path)}
await writeFile(join(dist,'sitemap.xml'),'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'+publicPages.map(page=>'  <url><loc>'+siteOrigin+page.path+'</loc></url>').join('\n')+'\n</urlset>\n')
