// Keep writes in user order and apply a response only to fields it still owns.
export class AccountWrites {
  private sequence = 0
  private latest = new Map<string, number>()
  private chain: Promise<unknown> = Promise.resolve()

  begin(id: string, patch: Record<string, unknown>) {
    const revision = ++this.sequence
    const keys = Object.keys(patch)
    for (const key of keys) this.latest.set(`${id}:${key}`, revision)
    return (value: Record<string, any>) => Object.fromEntries(keys
      .filter(key => this.latest.get(`${id}:${key}`) === revision)
      .map(key => [key, value[key]]))
  }

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task)
    this.chain = next.catch(() => undefined)
    return next
  }
}
