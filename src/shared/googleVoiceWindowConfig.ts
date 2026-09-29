type ProxyConfiguration = { enabled?: boolean; protocol?: string; host?: string; port?: number; username?: string; hasPassword?: boolean }

/** Compare effective routing only; saved inactive fields do not change system routing. */
export function googleVoiceProxyConnectionKey(proxy?: ProxyConfiguration): string {
  if (!proxy?.enabled) return 'system'
  return JSON.stringify([proxy.protocol, proxy.host?.toLowerCase(), proxy.port, proxy.username || '', proxy.hasPassword === true])
}

export function googleVoiceProxyNeedsReconnect(before: string, after: ProxyConfiguration | undefined, patch?: { password?: string; clearPassword?: boolean }): boolean {
  if (before !== googleVoiceProxyConnectionKey(after)) return true
  // A supplied credential can change authentication even when the visible fields
  // are unchanged. Empty password inputs deliberately retain the existing secret.
  return after?.enabled === true && Boolean(patch?.password || patch?.clearPassword)
}
