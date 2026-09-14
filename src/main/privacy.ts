/** Diagnostics are allowlisted categories, never raw upstream stderr or chat payloads. */
export function diagnosticSummary(value: unknown): string {
  const text = String(value || '').toLowerCase()
  if (/untrusted|identity.*changed|safety number/.test(text)) return '此联系人的安全码发生变化，请打开联系人资料核实安全码。'
  if (/linked devices|primary device/.test(text)) return '此设置需要在手机 Signal 中修改。'
  if (/not.*admin|permission|not.*member/.test(text)) return '当前账号没有这项群组权限。'
  if (/could not find avatar/.test(text)) return '此联系人尚未提供头像。'
  if (/not registered/.test(text) && /user|recipient/.test(text)) return '该手机号或用户名尚未注册 Signal。'
  if (/timeout|timed out/.test(text)) return '连接响应超时，请核对网络与待处理任务。'
  if (/unauthorized|forbidden|auth|credential/.test(text)) return '认证未通过，请重新检查账号连接。'
  if (/proxy|socks/.test(text)) return '代理连接异常，请检查此账号的代理配置。'
  if (/unsupportedclassversion|class file version/.test(text)) return 'Signal 运行组件版本不匹配，请重新准备。'
  if (/unsatisfiedlink|native library|dll/.test(text)) return 'Signal 运行组件不完整，请重新准备。'
  if (/locked|another process|already in use/.test(text)) return 'Signal 账号正在被另一个程序使用，请先退出重复运行的程序。'
  if (/unknown account|not registered/.test(text)) return 'Signal 设备关联已失效，请重新关联手机。'
  if (/exit|stopped|not running/.test(text)) return 'Signal 核心已停止；发送中的消息需要核对结果。'
  return 'Signal 核心报告了一条诊断事件。原始内容已隐藏。'
}
