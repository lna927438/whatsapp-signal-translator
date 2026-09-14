import { boundedOperation } from './boundedOperation'

/** Independent recovery lanes. Timeout releases the UI, but never duplicates an
 * operation that is still running underneath (resume/unlock often arrive together). */
export class RecoveryCoordinator {
  private jobs = new Map<string, Promise<unknown>>()
  async run(scope: string, jobs: Record<string, () => Promise<unknown> | unknown>, timeoutMs = 8000) {
    const results = await Promise.all(Object.entries(jobs).map(async ([name, start]) => {
      const key = scope + ':' + name
      let work = this.jobs.get(key)
      if (!work) {
        work = Promise.resolve().then(start)
        this.jobs.set(key, work)
        void work.finally(() => { if (this.jobs.get(key) === work) this.jobs.delete(key) }).catch(() => undefined)
      }
      try { await boundedOperation(work, timeoutMs, name + '仍在等待'); return { name, ok: true } }
      catch { return { name, ok: false } }
    }))
    return results
  }
}
