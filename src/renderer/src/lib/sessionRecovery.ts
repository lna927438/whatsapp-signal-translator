/** Only explicit credential failures require a new login; outages preserve it. */
export function requiresSessionLogin(error: unknown): boolean {
  const authError = error as { code?: unknown; name?: unknown; __isAuthError?: unknown }
  // auth-js converts session_not_found into this error and drops its code.
  if (authError?.__isAuthError === true && authError.name === 'AuthSessionMissingError') return true
  const code = String(authError?.code || '')
  return ['session_not_found', 'session_expired', 'refresh_token_not_found', 'refresh_token_already_used', 'bad_jwt', 'user_not_found'].includes(code)
}

export function boundedAuthWork<T>(work: Promise<T>, timeout = 9000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([work, new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('暂时无法连接登录服务，请恢复连接后重试。')), timeout)
  })]).finally(() => clearTimeout(timer))
}
