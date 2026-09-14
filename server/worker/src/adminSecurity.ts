export interface AdminIdentity { id: string; aal: 'aal1' | 'aal2'; mfaAt: number | null; enrolled: boolean; sessionId: string }
export const ADMIN_READ_SECONDS = 8 * 3600
export const ADMIN_WRITE_SECONDS = 10 * 60

/** Call only after the SAME bearer token has been authenticated by Supabase /user. */
export function authenticatedClaims(token: string, user: { id?: string; factors?: Array<{ status?: string; factor_type?: string }> }, issuer: string, now = Date.now() / 1000): AdminIdentity {
  try {
    const parts = token.split('.')
    if (parts.length !== 3 || token.length > 8192 || !parts[2]) throw new Error()
    const claims = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
    if (claims.sub !== user.id || claims.iss !== issuer.replace(/\/$/, '') + '/auth/v1' || claims.role !== 'authenticated' ||
      !(Array.isArray(claims.aud) ? claims.aud.includes('authenticated') : claims.aud === 'authenticated') ||
      !Number.isFinite(claims.exp) || claims.exp <= now || !Number.isFinite(claims.iat) || claims.iat > now + 30 ||
      !/^[0-9a-f-]{36}$/i.test(claims.session_id) || claims.is_anonymous === true) throw new Error()
    const times = (Array.isArray(claims.amr) ? claims.amr : []).filter((v: { method?: string; timestamp?: number }) => v.method === 'totp' &&
      typeof v.timestamp === 'number' && Number.isFinite(v.timestamp) && v.timestamp > 0 && v.timestamp <= now + 30).map((v: { timestamp: number }) => v.timestamp)
    return { id: user.id!, aal: claims.aal === 'aal2' ? 'aal2' : 'aal1', mfaAt: times.length ? Math.max(...times) : null,
      enrolled: Boolean(user.factors?.some(f => f.status === 'verified' && f.factor_type === 'totp')), sessionId: claims.session_id }
  } catch { throw new Error('unauthorized') }
}
export function mfaRequired(identity: AdminIdentity, write: boolean, now = Date.now() / 1000): boolean {
  return identity.aal !== 'aal2' || !identity.enrolled || identity.mfaAt === null || identity.mfaAt > now + 30 ||
    now - identity.mfaAt > (write ? ADMIN_WRITE_SECONDS : ADMIN_READ_SECONDS)
}
