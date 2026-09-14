type Turnstile={render:(node:HTMLElement,options:Record<string,unknown>)=>string;remove:(id:string)=>void}
let loading:Promise<Turnstile>|undefined,active=false
function load(){
 if(!loading)loading=new Promise<Turnstile>((resolve,reject)=>{const existing=(window as any).turnstile;if(existing){resolve(existing);return}const script=document.createElement('script');script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';script.async=true;script.onload=()=>resolve((window as any).turnstile);script.onerror=()=>{script.remove();loading=undefined;reject(new Error('安全验证暂时无法加载，请重试。'))};document.head.append(script)})
 return loading
}
export async function authCaptcha(force=false):Promise<string|undefined>{
 const key=String(import.meta.env.VITE_TURNSTILE_SITE_KEY||'')
 if(!key){if(force)throw new Error('安全验证尚未配置，请稍后重试。');return undefined}
 if(active)throw new Error('请先完成当前安全验证。')
 active=true
 const overlay=document.createElement('div'),panel=document.createElement('section'),heading=document.createElement('h2'),slot=document.createElement('div'),cancel=document.createElement('button')
 overlay.style.cssText='position:fixed;inset:0;z-index:5000;display:grid;place-items:center;background:#122a32ba;padding:16px'
 panel.style.cssText='background:#fff;color:#173a2c;padding:24px;border-radius:16px;width:350px;max-width:100%;box-sizing:border-box'
 panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-label','安全验证');heading.textContent='完成安全验证';cancel.textContent='取消';cancel.type='button';cancel.style.cssText='margin-top:20px;padding:8px 16px;cursor:pointer'
 panel.append(heading,slot,cancel);overlay.append(panel);document.body.append(overlay);cancel.focus()
 let widget:string|undefined,api:Turnstile|undefined
 try{return await new Promise<string>((resolve,reject)=>{
   let ended=false
   const end=(error?:Error,token?:string)=>{if(ended)return;ended=true;clearTimeout(timer);error?reject(error):resolve(token!)}
   const timer=setTimeout(()=>end(new Error('安全验证超时，请重试。')),120000)
   cancel.onclick=()=>end(new Error('已取消安全验证。'))
   void load().then(value=>{api=value;if(ended)return;widget=api.render(slot,{sitekey:key,theme:'light',callback:(token:string)=>end(undefined,token),'error-callback':()=>end(new Error('安全验证失败，请重试。')),'expired-callback':()=>end(new Error('安全验证已过期，请重试。'))})}).catch(()=>end(new Error('安全验证暂时不可用，请重试。')))
 })}finally{if(widget&&api)try{api.remove(widget)}catch{}overlay.remove();active=false}
}
