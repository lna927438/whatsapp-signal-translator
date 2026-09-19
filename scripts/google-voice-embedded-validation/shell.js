const tabs=document.querySelector('#tabs'), origin=document.querySelector('#origin'), status=document.querySelector('#status'), blocking=document.querySelector('#blocking')
function render(snapshot){
 tabs.replaceChildren(...snapshot.accounts.map(account=>{const button=document.createElement('button');button.textContent=account.label;button.className=account.id===snapshot.selected?'active':'';button.onclick=()=>window.prototype.choose(account.id);return button}))
 origin.textContent=snapshot.state?.origin?'当前官方来源：'+snapshot.state.origin:'尚未加载官方页面'
 status.textContent=snapshot.error || (snapshot.state?.status==='loading'?'正在加载官方页面…':snapshot.state?.popupDepth?'Google 登录或页面弹窗仍在客户端内部，可点“返回”回到原页面。':'当前为独立内嵌验证；能打开页面不等于已通过登录。')
 blocking.textContent='官方页面加载失败，可点击“重新加载”或“Google 登录”重试。';blocking.classList.toggle('show',snapshot.state?.status==='failed')
}
document.querySelector('#add').onclick=()=>window.prototype.add()
document.querySelector('#back').onclick=()=>window.prototype.back()
document.querySelector('#reload').onclick=()=>window.prototype.reload()
document.querySelector('#signin').onclick=()=>window.prototype.signin()
window.prototype.changed(render)
window.prototype.snapshot().then(render)
