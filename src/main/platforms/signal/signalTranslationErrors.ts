import { quarantinedTranslationMessage, translationFailureMessage } from '../../translation/providers/cloudflare'

export const signalTranslationErrorFallback = '翻译暂未完成。原请求已保留，请核对消息详情后重试原消息。'

// Exact, application-owned messages only. Use the actual provider formatter so
// its confirmed-failure suffixes cannot silently fall out of this boundary.
const safeMessages = new Set([
  ...[undefined, 'provider_not_translation', 'provider_timeout', 'provider_unavailable', 'provider_rate_limit', 'translation_outcome_unknown'].map(translationFailureMessage),
  quarantinedTranslationMessage,
  '可用字符已用完，无法发送翻译消息。请补充字符后重试，草稿已保留。',
  '可用字符余额不足。原请求已保留，结算以查询结果为准。',
  '字符余额尚未核实，消息未发送。请恢复连接后重试。',
  '云端余额尚未通过校验，请重新同步。',
  '账号状态不可用，消息未发送。',
  '账号已停用，无法使用在线翻译。原请求仍需核对。',
  '账号已停用，请联系管理员。',
  'Signal 账号不可用。',
  '中文发送设置正在保存，请稍后重试。',
  '译文仍含中文，已阻止发送并保留草稿。',
  '仍含中文原文，已阻止发送。请开启发送翻译后重试。',
  '译文为空，消息未发送。原文已保留。',
  '译文中的链接、号码或术语不完整，消息未发送。请修改译文后重试。',
  '译文语言与目标不符，消息未发送。请修改译文或检查目标语言。',
  '请先登录在线账号。',
  '登录状态已变化。',
  '登录状态已变化，消息未发送。',
  '登录状态已变化，已取消旧账号的翻译任务。',
  '登录状态已变化，请重新登录。草稿已保留。',
  '登录会话已失效，请重新登录。草稿与翻译记录已保留。',
  '登录已失效，请重新登录。',
  '暂时无法恢复在线登录，请检查网络或重新登录。草稿已保留。',
  '在线登录尚未恢复，请重新登录。草稿已保留。',
  '登录状态尚未恢复，草稿已保留。',
  '在线登录令牌缺失，请重新登录。',
  '在线登录状态已过期，请重新登录。',
  '在线登录状态已过期，请重新登录后核对原请求。',
  '原发送记录尚未核实，消息未发送。请在原消息上重试。',
  '原请求内容已清理，不能再次提交。',
  '原请求包含已清理的内容，只能查询原结果，不能再次提交。',
  '请求上下文已清理，原任务不会自动重新提交。',
  '本机译文已按保留期清理，不会自动重新翻译。',
  '此消息已删除或过期，不能再次翻译。',
  '此历史译文已按保留期清理，原结算记录仍保留，不会自动重新翻译或扣费。',
  '原译文已过期或尚未完成。',
  '此消息的重试记录过多，请复制原文后联系支持。',
  '云端结算回执不完整，已保留原请求等待核对。',
  '服务端尚未提供结果查询，原请求已保留。请在记录中核对，不要重新创建任务。',
  '暂时无法核对原请求。恢复连接后继续查询。',
  '原请求结果待确认，恢复连接后会继续核对。',
  '云端仍在处理此请求，请稍后继续核对。',
  '翻译结果待确认，原请求和草稿已保留。恢复连接后继续核对。',
  '尚未连通翻译选项服务，本次未发起翻译、未扣费。',
  '服务端尚未启用语气与术语功能。本次未发起翻译、未扣费。',
  '今日翻译费用已达到保护上限，请联系管理员核对。原消息和草稿已保留。',
  '翻译正在安全维护，请稍后继续。原消息和草稿已保留。',
  '翻译请求较多，请稍后重试。原消息和草稿已保留。',
  '暂时无法连接服务。请检查网络，或切换线路后重试。',
  '服务请求超时，原请求和草稿已保留。',
])

export function signalTranslationErrorMessage(error: unknown): string {
  try {
    // Do not stringify unknown errors or evaluate their getters. Never copy
    // arbitrary suffixes, request bodies, provider responses, causes or stacks.
    const message = error !== null && typeof error === 'object'
      ? Object.getOwnPropertyDescriptor(error, 'message')?.value : undefined
    if (typeof message === 'string' && safeMessages.has(message)) return message
  } catch { /* An exotic error object remains an unknown failure. */ }
  return signalTranslationErrorFallback
}
