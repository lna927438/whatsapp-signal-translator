export type GoogleVoiceProbeName = 'exitIp' | 'voice' | 'signIn'
export type GoogleVoiceProbeCode = 'proxy-auth' | 'proxy-connect' | 'network-error' | 'timeout' | 'http-error' | 'invalid-response' | 'redirect-blocked' | 'cancelled'
export interface GoogleVoiceNetworkProbe {
  status: 'reachable' | 'failed'
  latencyMs: number
  checkedAt: number
  code?: GoogleVoiceProbeCode
  /** Numeric status only; never expose headers, redirect URLs or page content. */
  httpStatus?: number
}
/** Cookie-free endpoint reachability only; never proof of login, SMS or uploads. */
export interface GoogleVoiceNetworkCheck {
  reachable: boolean
  ip?: string
  latencyMs: number
  checkedAt: number
  checks: Record<GoogleVoiceProbeName, GoogleVoiceNetworkProbe>
}
export interface GoogleVoiceNetworkState extends Partial<GoogleVoiceNetworkCheck> {
  mode: 'proxy' | 'system'
  status: 'unchecked' | 'checking' | 'checked' | 'error'
  message?: string
}
