import { JsonStore } from './jsonStore'

export class OnlineSessionStore {
  private store = new JsonStore<Record<string,string>>('online-auth-v1.json', {}, true)
  private queue: Promise<unknown> = Promise.resolve()
  private key(key: string) { if (typeof key !== 'string' || !/^sb-[a-z0-9-]{1,100}-auth-token(?:-code-verifier)?$/.test(key)) throw new Error('登录记录名称无效。') }
  async get(key: string): Promise<string | null> { this.key(key); await this.queue.catch(() => undefined); return (await this.store.read())[key] ?? null }
  set(key: string, value: string | null): Promise<void> {
    this.key(key)
    if (value !== null && (typeof value !== 'string' || value.length > 131072)) return Promise.reject(new Error('登录记录格式无效。'))
    const work = this.queue.catch(() => undefined).then(async () => {
      const data = await this.store.read()
      if (value === null) delete data[key]; else data[key] = value
      if (Object.keys(data).length > 8) throw new Error('登录记录数量异常。')
      await this.store.write(data)
    })
    this.queue = work
    return work
  }
}
