const status = document.getElementById('status'), form = document.getElementById('pair'), input = document.getElementById('code')
let busy = false
async function run(type, extra = {}) {
  if (busy) return
  busy = true; document.querySelectorAll('button').forEach(button => { button.disabled = true })
  try {
    const answer = await chrome.runtime.sendMessage({ v: 1, type, ...extra })
    if (!answer?.ok) throw new Error(answer?.error || '连接未完成，请检查 HelloDog 并使用新的连接码。')
    if (type === 'pair') input.value = ''
    const result = answer.result
    status.textContent = result.paired ? result.status?.connected === false ? '已配对，HelloDog 当前未连接。' : '已连接 HelloDog。请查看短信编辑器上方的保护状态。' : '尚未连接 HelloDog。'
  } catch (error) { status.textContent = error?.message || '连接未完成，请检查 HelloDog 和本机桥接安装；也可重新获取连接码。' }
  finally { busy = false; document.querySelectorAll('button').forEach(button => { button.disabled = false }) }
}
form.addEventListener('submit', event => { event.preventDefault(); void run('pair', { code: input.value }) })
document.getElementById('refresh').onclick = () => run('status')
document.getElementById('disconnect').onclick = () => run('disconnect')
void run('status')
