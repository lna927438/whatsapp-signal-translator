export interface KeyStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
const preferenceKey = 'translator-remember-login'

export class AuthStorage {
  private readonly keys = new Set<string>()
  constructor(private readonly persistent: KeyStorage, private readonly temporary: KeyStorage) {}
  setRemember(remember: boolean): void { this.persistent.setItem(preferenceKey, String(remember)) }
  getItem(key: string): string | null {
    this.keys.add(key)
    return this.temporary.getItem(key) ?? this.persistent.getItem(key)
  }
  setItem(key: string, value: string): void {
    this.keys.add(key)
    const remember = this.persistent.getItem(preferenceKey) !== 'false'
    const target = remember ? this.persistent : this.temporary
    const other = remember ? this.temporary : this.persistent
    target.setItem(key, value)
    other.removeItem(key)
  }
  removeItem(key: string): void {
    this.keys.add(key)
    this.persistent.removeItem(key)
    this.temporary.removeItem(key)
  }
  clearSession(): void { for (const key of this.keys) this.removeItem(key) }
}
