import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'crypto'
import { promisify } from 'util'
import { JsonStore } from './jsonStore'

const scrypt = promisify(scryptCallback)

interface LocalUserRecord {
  id: string
  username: string
  usernameKey: string
  email: string
  emailKey: string
  passwordHash: string
  passwordSalt: string
  recoveryHash: string
  recoverySalt: string
  createdAt: number
  updatedAt: number
}

interface StoredAccount { user?: LocalUserRecord }
interface StoredSession { userId?: string; createdAt?: number }

export interface PublicAuthUser {
  id: string
  username: string
  email: string
  createdAt: number
}

export interface AuthStatus {
  hasAccount: boolean
  authenticated: boolean
  user?: PublicAuthUser
}

export interface RegisterResult extends AuthStatus {
  recoveryCode: string
}

const normalizeUsername = (value: string) => String(value || '').trim()
const normalizeEmail = (value: string) => String(value || '').trim().toLowerCase()
const identifierKey = (value: string) => String(value || '').trim().toLowerCase()

function validateIdentity(username: string, email: string): void {
  if (username.length < 3 || username.length > 40) throw new Error('用户名需要 3–40 个字符。')
  if (!/^[\p{L}\p{N}_.-]+$/u.test(username)) throw new Error('用户名只能包含字母、数字、中文、下划线、点和短横线。')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('请输入有效的邮箱地址。')
}

function validatePassword(password: string): void {
  if (password.length < 8) throw new Error('密码至少需要 8 个字符。')
  if (password.length > 200) throw new Error('密码过长。')
}

async function derive(secret: string, saltHex: string): Promise<Buffer> {
  return await scrypt(secret, Buffer.from(saltHex, 'hex'), 64) as Buffer
}

async function hashSecret(secret: string, saltHex?: string): Promise<{ salt: string; hash: string }> {
  const salt = saltHex || randomBytes(16).toString('hex')
  const hash = await derive(secret, salt)
  return { salt, hash: hash.toString('hex') }
}

async function verifySecret(secret: string, salt: string, expectedHex: string): Promise<boolean> {
  try {
    const actual = await derive(secret, salt)
    const expected = Buffer.from(expectedHex, 'hex')
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

function recoveryCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(10)
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')
}

export class AuthStore {
  private readonly accountStore = new JsonStore<StoredAccount>('auth-account.json', {})
  private readonly sessionStore = new JsonStore<StoredSession>('auth-session.json', {})
  private currentUserId?: string

  async status(): Promise<AuthStatus> {
    const user = await this.readUser()
    if (!user) return { hasAccount: false, authenticated: false }

    if (!this.currentUserId) {
      const session = await this.sessionStore.read()
      if (session.userId === user.id) this.currentUserId = user.id
    }

    return {
      hasAccount: true,
      authenticated: this.currentUserId === user.id,
      user: this.currentUserId === user.id ? this.publicUser(user) : undefined
    }
  }

  async register(input: { username: string; email: string; password: string; remember?: boolean }): Promise<RegisterResult> {
    const existing = await this.readUser()
    if (existing) throw new Error('这台电脑已经创建了一个本地账号。请直接登录。')

    const username = normalizeUsername(input.username)
    const email = normalizeEmail(input.email)
    const password = String(input.password || '')
    validateIdentity(username, email)
    validatePassword(password)

    const recovery = recoveryCode()
    const passwordSecret = await hashSecret(password)
    const recoverySecret = await hashSecret(recovery)
    const now = Date.now()
    const user: LocalUserRecord = {
      id: randomUUID(),
      username,
      usernameKey: identifierKey(username),
      email,
      emailKey: identifierKey(email),
      passwordHash: passwordSecret.hash,
      passwordSalt: passwordSecret.salt,
      recoveryHash: recoverySecret.hash,
      recoverySalt: recoverySecret.salt,
      createdAt: now,
      updatedAt: now
    }

    await this.accountStore.write({ user })
    this.currentUserId = user.id
    if (input.remember !== false) await this.sessionStore.write({ userId: user.id, createdAt: now })
    else await this.sessionStore.write({})

    return { hasAccount: true, authenticated: true, user: this.publicUser(user), recoveryCode: recovery }
  }

  async login(input: { identifier: string; password: string; remember?: boolean }): Promise<AuthStatus> {
    const user = await this.readUser()
    if (!user) throw new Error('尚未注册账号，请先注册。')

    const key = identifierKey(input.identifier)
    if (!key || (key !== user.usernameKey && key !== user.emailKey)) throw new Error('用户名或邮箱不存在。')
    const ok = await verifySecret(String(input.password || ''), user.passwordSalt, user.passwordHash)
    if (!ok) throw new Error('密码错误。')

    this.currentUserId = user.id
    if (input.remember !== false) await this.sessionStore.write({ userId: user.id, createdAt: Date.now() })
    else await this.sessionStore.write({})
    return { hasAccount: true, authenticated: true, user: this.publicUser(user) }
  }

  async logout(): Promise<AuthStatus> {
    this.currentUserId = undefined
    await this.sessionStore.write({})
    const user = await this.readUser()
    return { hasAccount: Boolean(user), authenticated: false }
  }

  async updateIdentity(patch: { username?: string; email?: string }): Promise<PublicAuthUser | undefined> {
    const user = await this.readUser()
    if (!user) return undefined
    const username = patch.username === undefined ? user.username : normalizeUsername(patch.username)
    const email = patch.email === undefined ? user.email : normalizeEmail(patch.email)
    validateIdentity(username, email)
    user.username = username
    user.usernameKey = identifierKey(username)
    user.email = email
    user.emailKey = identifierKey(email)
    user.updatedAt = Date.now()
    await this.accountStore.write({ user })
    return this.publicUser(user)
  }

  async resetPassword(input: { identifier: string; recoveryCode: string; newPassword: string }): Promise<boolean> {
    const user = await this.readUser()
    if (!user) throw new Error('尚未注册账号。')
    const key = identifierKey(input.identifier)
    if (key !== user.usernameKey && key !== user.emailKey) throw new Error('用户名或邮箱不存在。')
    validatePassword(String(input.newPassword || ''))
    const recoveryOk = await verifySecret(String(input.recoveryCode || '').trim().toUpperCase(), user.recoverySalt, user.recoveryHash)
    if (!recoveryOk) throw new Error('恢复码不正确。')
    const passwordSecret = await hashSecret(String(input.newPassword))
    user.passwordHash = passwordSecret.hash
    user.passwordSalt = passwordSecret.salt
    user.updatedAt = Date.now()
    await this.accountStore.write({ user })
    await this.sessionStore.write({})
    this.currentUserId = undefined
    return true
  }

  private async readUser(): Promise<LocalUserRecord | undefined> {
    return (await this.accountStore.read()).user
  }

  private publicUser(user: LocalUserRecord): PublicAuthUser {
    return { id: user.id, username: user.username, email: user.email, createdAt: user.createdAt }
  }
}
