const {writeFileSync}=require('fs')
const {join}=require('path')

// Fixed metadata only. Never write a full URL, query, fragment, headers, body,
// page text, input values, cookies, credentials or Google session parameters.
function installDiagnostics(app,directory){
 const rows=[],sessions=new WeakSet()
 const origin=value=>{try{const url=new URL(value);return url.protocol==='https:'?url.origin:''}catch{return ''}}
 const record=(type,fields={})=>{
  rows.push({at:new Date().toISOString(),type,...fields});if(rows.length>160)rows.shift()
  writeFileSync(join(directory,'interactive-diagnostic.json'),JSON.stringify({scope:'Validation only; domain, navigation type and HTTP/network status. No credentials or message content.',events:rows},null,2))
 }
 app.on('web-contents-created',(_event,wc)=>{
  wc.on('did-start-navigation',(event,url,_inPlace,isMain)=>{if((event.isMainFrame??isMain)&&origin(event.url||url))record('navigation-start',{origin:origin(event.url||url)})})
  wc.on('did-navigate',(_event,url)=>{if(origin(url))record('navigation-committed',{origin:origin(url)})})
  wc.on('did-fail-load',(_event,code,_description,url,isMain)=>{if(isMain&&origin(url))record('main-load-error',{origin:origin(url),code})})
  wc.on('render-process-gone',(_event,details)=>record('renderer-ended',{reason:['clean-exit','abnormal-exit','killed','crashed','oom','launch-failed','integrity-failure','memory-eviction'].includes(details.reason)?details.reason:'unknown'}))
  if(sessions.has(wc.session))return;sessions.add(wc.session)
  const filter={urls:['https://*/*']}
  wc.session.webRequest.onCompleted(filter,details=>{
   const host=origin(details.url)
   if(host&&(details.resourceType==='mainFrame'||details.statusCode>=400||(details.resourceType==='xhr'&&host==='https://accounts.google.com')))
    record('http-completed',{origin:host,status:details.statusCode,resource:details.resourceType})
  })
  wc.session.webRequest.onErrorOccurred(filter,details=>{
   const host=origin(details.url)
   if(host)record('network-error',{origin:host,error:/^net::ERR_[A-Z0-9_]+$/.test(details.error)?details.error:'network-failure',resource:details.resourceType})
  })
 })
 record('started')
 return event=>record('navigation-blocked',{origin:origin(event.origin),reason:['navigation','popup-limit','popup-unavailable','background-tab'].includes(event.reason)?event.reason:'unknown'})
}
module.exports={installDiagnostics}
