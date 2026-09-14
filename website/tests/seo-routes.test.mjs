import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import worker from '../worker.mjs'

const env = {ASSETS:{async fetch(request){
  const path = new URL(request.url).pathname
  try {
    const body = await readFile(new URL('../dist'+path, import.meta.url))
    return new Response(request.method === 'HEAD' ? null : body, {headers:{'Content-Type':path.endsWith('.html')?'text/html':'application/octet-stream'}})
  } catch { return new Response(null, {status:404}) }
}}}
const get = (path, method='GET') => worker.fetch(new Request('https://hellodog.net'+path,{method}),env)

test('public pages expose content and a unique canonical without JavaScript',async()=>{
  for(const path of ['/','/download','/guide','/updates']){
    const r=await get(path),html=await r.text()
    assert.equal(r.status,200)
    assert.equal(r.headers.get('X-Robots-Tag'),null)
    assert.match(html,/<h1[^>]*>[^<]+/)
    assert.match(html,/data-prerender="true"/)
    assert.ok(html.includes('rel="canonical" href="https://hellodog.net'+path+'"'))
    const schema=JSON.parse(html.match(/<script id="hellodog-schema" type="application\/ld\+json">(.*?)<\/script>/s)[1])
    assert.equal(schema['@context'],'https://schema.org')
    assert.ok(schema['@graph'].some(item=>item.name==='HelloDog'))
  }
  assert.notEqual((await (await get('/')).text()).match(/<title>(.*?)<\/title>/)[1],(await (await get('/download')).text()).match(/<title>(.*?)<\/title>/)[1])
})
test('crawler files are real text/XML and include only public canonical pages',async()=>{
  const robots=await get('/robots.txt'),sitemap=await get('/sitemap.xml')
  assert.match(robots.headers.get('content-type'),/^text\/plain/)
  assert.match(await robots.text(),/Sitemap: https:\/\/hellodog.net\/sitemap.xml/)
  assert.match(sitemap.headers.get('content-type'),/^application\/xml/)
  const xml=await sitemap.text()
  assert.match(xml,/<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/)
  assert.deepEqual([...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m=>m[1]),['https://hellodog.net/','https://hellodog.net/download','https://hellodog.net/guide','https://hellodog.net/updates'])
})
test('private routes stay unrendered and excluded from indexing',async()=>{
  for(const path of ['/login?next=%2Faccount','/account','/admin','/admin/announcements']){
    const r=await get(path),html=await r.text()
    assert.equal(r.status,200)
    assert.equal(r.headers.get('X-Robots-Tag'),'noindex, nofollow')
    assert.match(html,/<div id="app"><\/div>/)
    assert.match(html,/name="robots" content="noindex, nofollow"/)
    assert.doesNotMatch(html,/rel="canonical"|data-prerender|application\/ld\+json/)
  }
})
test('unknown and internal routes are real 404s, including HEAD requests',async()=>{
  for(const path of ['/does-not-exist-seo-check','/_app-shell.html','/assets/missing.js']){
    const r=await get(path)
    assert.equal(r.status,404)
    assert.match(r.headers.get('X-Robots-Tag'),/noindex/)
    const head=await get(path,'HEAD')
    assert.equal(head.status,404)
    assert.equal(await head.text(),'')
  }
})
test('aliases preserve query strings and www converges on the main domain',async()=>{
  for(const [path,target]of [['/download/','/download'],['/index.html','/'],['/download.html','/download'],['/guide/','/guide'],['/guide.html','/guide'],['/updates/','/updates'],['/updates.html','/updates'],['/admin/','/admin']]){
    const r=await get(path+'?ref=test')
    assert.equal(r.status,308)
    assert.equal(r.headers.get('location'),'https://hellodog.net'+target+'?ref=test')
  }
  const r=await worker.fetch(new Request('https://www.hellodog.net/download?ref=test'),env)
  assert.equal(r.status,308)
  assert.equal(r.headers.get('location'),'https://hellodog.net/download?ref=test')
})
