export const siteOrigin='https://hellodog.net'
export const brandAlternates=['HelloDog 翻译器','HelloDog 聊天翻译']
export const githubProject='https://github.com/lna927438/whatsapp-signal-translator'
export const publicPages=[
  {path:'/',file:'index.html',title:'HelloDog 翻译器官网 | WhatsApp、Signal 与 Telegram 聊天翻译',description:'HelloDog 翻译器是一款用于 WhatsApp、Signal 和 Telegram 的 Windows 聊天翻译软件。支持双向文字翻译、手动语音中英双语、多账号切换与译文缓存。官网下载客户端，了解安装和使用方法。'},
  {path:'/download',file:'download.html',title:'HelloDog 翻译器下载 | Windows 官方下载与更新',description:'从 HelloDog 官网下载 Windows 聊天翻译客户端，查看最新版本、安装升级说明、文件校验码和对应源代码。支持 WhatsApp、Signal 与 Telegram。'},
  {path:'/guide',file:'guide.html',title:'HelloDog 翻译器使用指南 | 安装、聊天翻译与字符用量',description:'了解如何安装 HelloDog 翻译器、连接 WhatsApp、Signal 和 Telegram、设置文字与语音翻译、查看历史消息译文和字符用量，以及处理常见发送与翻译问题。'},
  {path:'/updates',file:'updates.html',title:'HelloDog 翻译器更新记录 | 版本改进与升级说明',description:'查看 HelloDog 已发布版本的更新记录，包括聊天翻译、图片右键操作、界面布局、版本提醒和消息中心的改进，以及 Windows 客户端升级说明。'}
] as const
export function pageSeo(path:string){
  const page=publicPages.find(item=>item.path===path)
  if(page)return {...page,index:true}
  return {title:(path.startsWith('/admin')?'管理后台':path==='/account'?'用户中心':path==='/login'?'登录与注册':'页面不存在')+' | HelloDog',description:'HelloDog 跨语言聊天软件',path,index:false}
}
export function structuredData(path:string){
  const page=publicPages.find(item=>item.path===path)
  if(!page)return null
  const app={'@type':'SoftwareApplication','@id':siteOrigin+'/#software',name:'HelloDog',alternateName:brandAlternates,url:siteOrigin+'/',downloadUrl:siteOrigin+'/download',operatingSystem:'Windows',applicationCategory:'CommunicationApplication',description:publicPages[0].description,image:siteOrigin+'/hellodog-icon.webp'}
  const webpage={'@type':path==='/updates'?'CollectionPage':'WebPage','@id':siteOrigin+path+'#webpage',name:page.title,description:page.description,url:siteOrigin+path,isPartOf:{'@id':siteOrigin+'/#website'},about:{'@id':app['@id']},inLanguage:'zh-CN'}
  return {'@context':'https://schema.org','@graph':path==='/'?[{'@type':'WebSite','@id':siteOrigin+'/#website',name:'HelloDog',alternateName:brandAlternates,url:siteOrigin+'/',sameAs:[githubProject],inLanguage:'zh-CN'},app,webpage]:[app,webpage]}
}
export function updatePageSeo(path:string){
  const seo=pageSeo(path);document.title=seo.title
  const meta=(name:string,content:string,property=false)=>{const attr=property?'property':'name';let el=document.head.querySelector<HTMLMetaElement>('meta['+attr+'="'+name+'"]');if(!el){el=document.createElement('meta');el.setAttribute(attr,name);document.head.append(el)}el.content=content}
  meta('description',seo.description);meta('robots',seo.index?'index, follow':'noindex, nofollow');meta('og:title',seo.title,true);meta('og:description',seo.description,true);meta('og:site_name','HelloDog',true);meta('og:type','website',true);meta('og:image',siteOrigin+'/hellodog-icon.webp',true)
  let canonical=document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')
  if(seo.index){if(!canonical){canonical=document.createElement('link');canonical.rel='canonical';document.head.append(canonical)}canonical.href=siteOrigin+seo.path;meta('og:url',siteOrigin+seo.path,true)}else{canonical?.remove();document.head.querySelector('meta[property="og:url"]')?.remove()}
  let schema=document.head.querySelector<HTMLScriptElement>('#hellodog-schema');const data=structuredData(path)
  if(data){if(!schema){schema=document.createElement('script');schema.id='hellodog-schema';schema.type='application/ld+json';document.head.append(schema)}schema.textContent=JSON.stringify(data)}else schema?.remove()
}
