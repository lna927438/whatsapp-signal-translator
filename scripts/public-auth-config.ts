import type { Plugin } from 'vite'

const urlVariable = 'VITE_SUPABASE_URL'
const keyVariable = 'VITE_SUPABASE_PUBLISHABLE_KEY'

function invalidConfig(variable: string, reason: string): never {
  // Values are deliberately excluded: a misconfigured public variable may hold a secret.
  throw new Error(`[HelloDog public auth] ${variable} ${reason}. Configure the public account service in the build environment or Vite env files, then rebuild. No installer should be distributed from this build.`)
}

function isPlaceholder(value: string): boolean {
  return /(?:your[-_]|replace[-_]?me|placeholder|changeme|example|project[-_]ref)/i.test(value)
    || /^(?:x+|0+|\.{3,}|<.*>)$/i.test(value)
}

/** Validate the exact public values Vite will embed, without network access or logging keys. */
export function validatePublicAuthConfig(env: Record<string, unknown>): void {
  const urlValue = typeof env[urlVariable] === 'string' ? env[urlVariable].trim() : ''
  const keyValue = typeof env[keyVariable] === 'string' ? env[keyVariable].trim() : ''
  if (!urlValue) invalidConfig(urlVariable, 'is missing')
  if (!keyValue) invalidConfig(keyVariable, 'is missing')

  let url: URL
  try { url = new URL(urlValue) } catch { invalidConfig(urlVariable, 'must be a valid HTTPS project URL') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    invalidConfig(urlVariable, 'must be an HTTPS project origin without credentials, query, fragment, or path')
  }
  if (isPlaceholder(url.hostname) || /(?:^|\.)(?:localhost|local|invalid|test|example)$/.test(url.hostname)
    || url.hostname === '[::1]' || /^127\./.test(url.hostname) || url.hostname === '0.0.0.0') {
    invalidConfig(urlVariable, 'must point to the real account service, not a placeholder or local host')
  }

  if (keyValue.startsWith('sb_secret_')) invalidConfig(keyVariable, 'must never contain a Supabase secret key')
  if (keyValue.startsWith('sb_publishable_')) {
    const token = keyValue.slice('sb_publishable_'.length)
    if (!/^[A-Za-z0-9_-]{20,}$/.test(token) || isPlaceholder(token)) {
      invalidConfig(keyVariable, 'must contain a complete publishable key, not a placeholder')
    }
    return
  }

  // Legacy anon JWTs remain supported by Supabase. Decode only to reject unsafe roles;
  // authenticity and project availability are checked separately against the service.
  const parts = keyValue.split('.')
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) {
    invalidConfig(keyVariable, 'must contain a publishable key or legacy anon key')
  }
  let header: Record<string, unknown>
  let payload: Record<string, unknown>
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch { invalidConfig(keyVariable, 'contains an invalid legacy key') }
  if (!payload || payload.role !== 'anon') {
    invalidConfig(keyVariable, 'must use the public anon role; privileged and user session keys are forbidden')
  }
  if (!header || header.alg !== 'HS256' || header.typ !== 'JWT' || payload.iss !== 'supabase') {
    invalidConfig(keyVariable, 'must contain a Supabase legacy anon key')
  }
}

export function publicAuthBuildGuard(): Plugin {
  return {
    name: 'hellodog-public-auth-config',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      // Vite has already applied .env, mode-specific files, and process.env precedence.
      // Every build mode is guarded because any mode can be packaged as an installer.
      validatePublicAuthConfig(config.env)
    }
  }
}
