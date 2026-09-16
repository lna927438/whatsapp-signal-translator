import type { BridgedSession } from './sessionCoordinator'

export interface DesktopAssuranceClient {
  auth: { mfa: { getAuthenticatorAssuranceLevel(jwt?: string): Promise<{
    data: { currentLevel: string | null; nextLevel: string | null } | null
    error: unknown
  }> } }
}

/** Pass the explicit token so the SDK validates the server-side session and
 * current factors. A locally unexpired JWT alone cannot prove a live session. */
export async function inspectDesktopAssurance(client: DesktopAssuranceClient, session: BridgedSession): Promise<'ready' | 'mfa'> {
  if (!session?.user?.id || !session.access_token) throw new Error('没有获得有效登录会话，请重试。')
  const { data, error } = await client.auth.mfa.getAuthenticatorAssuranceLevel(session.access_token)
  if (error) throw error
  if (data?.currentLevel === 'aal2') return 'ready'
  if (data?.currentLevel === 'aal1' && data.nextLevel === 'aal2') return 'mfa'
  if (data?.currentLevel === 'aal1' && data.nextLevel === 'aal1') return 'ready'
  throw new Error('暂时无法核对账号安全状态，请恢复连接后重试。')
}

/** A successful challenge must produce AAL2, not merely remove the MFA prompt. */
export async function confirmDesktopMfa(client: DesktopAssuranceClient, session: BridgedSession): Promise<void> {
  const { data, error } = await client.auth.mfa.getAuthenticatorAssuranceLevel(session.access_token)
  if (error) throw error
  if (data?.currentLevel !== 'aal2') throw new Error('安全验证尚未完成，请重试。')
}

export interface DesktopTotpFactor { id: string; friendly_name?: string }
export function verifiedTotpFactors(data: { all?: Array<{ id?: unknown; factor_type?: unknown; status?: unknown; friendly_name?: unknown }> } | null): DesktopTotpFactor[] {
  return (data?.all || []).filter(factor => factor.factor_type === 'totp' && factor.status === 'verified' && typeof factor.id === 'string' && factor.id.length > 0)
    .map(factor => ({ id: factor.id as string, ...(typeof factor.friendly_name === 'string' ? { friendly_name: factor.friendly_name } : {}) }))
}
