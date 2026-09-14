export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.hostname === 'www.hellodog.net') {
      url.hostname = 'hellodog.net'
      return Response.redirect(url.toString(), 308)
    }
    if (url.hostname === 'admin.hellodog.net' && ['/', '/login'].includes(url.pathname)) {
      url.pathname = '/admin'
      return Response.redirect(url.toString(), 307)
    }
    const path = url.pathname
    const privatePage = url.hostname === 'admin.hellodog.net' || path === '/security-check' || path === '/login' || path === '/account' || path === '/admin' || path.startsWith('/admin/')
    const aliases = { '/index.html': '/', '/download.html': '/download', '/download/': '/download', '/guide.html': '/guide', '/guide/': '/guide', '/updates.html': '/updates', '/updates/': '/updates', '/login/': '/login', '/account/': '/account', '/admin/': '/admin' }
    if (aliases[path]) {
      url.pathname = aliases[path]
      return Response.redirect(url.toString(), 308)
    }
    const publicFiles = { '/': '/index.html', '/download': '/download.html', '/guide': '/guide.html', '/updates': '/updates.html' }
    const publicPage = Object.hasOwn(publicFiles, path)
    const appPage = path === '/security-check' || publicPage || path === '/login' || path === '/account' || /^\/admin(?:\/[^/]+)?$/.test(path)
    const assetUrl = new URL(url)
    // Public pages have their own rendered document. Private routes share an empty, noindex shell.
    if (appPage) assetUrl.pathname = publicPage ? publicFiles[path] : '/_app-shell.html'
    let response = path === '/_app-shell.html' ? new Response(null, { status: 404 }) : await env.ASSETS.fetch(new Request(assetUrl, request))
    if (response.status === 404) {
      response = new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>页面不存在 | HelloDog</title><body><main><h1>页面不存在</h1><p>这个地址没有对应的页面。</p><a href="/">返回 HelloDog 官网</a></main></body></html>', { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    }
    const headers = new Headers(response.headers)
    headers.set('X-Content-Type-Options', 'nosniff')
    headers.set('X-Frame-Options', 'DENY')
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
    headers.set('Strict-Transport-Security', 'max-age=31536000')
    headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com https://api.hellodog.net https://download.hellodog.net https://iqxpliruaeuqklxdnybd.supabase.co wss://iqxpliruaeuqklxdnybd.supabase.co; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'")
    if ((headers.get('Content-Type') || '').includes('text/html')) headers.set('Cache-Control', 'no-store')
    if (privatePage || response.status === 404) headers.set('X-Robots-Tag', 'noindex, nofollow')
    if (path === '/robots.txt' && response.ok) headers.set('Content-Type', 'text/plain; charset=utf-8')
    if (path === '/sitemap.xml' && response.ok) headers.set('Content-Type', 'application/xml; charset=utf-8')
    return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, statusText: response.statusText, headers })
  }
}
