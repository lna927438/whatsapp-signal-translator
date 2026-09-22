/** Successful reads may retain their start-to-start cadence. Failures always
 * back off from completion; callers coalesce in-flight work and manual retries. */
export class ReadPolling {
  private nextAt = 0
  private failures = 0
  constructor(private interval: number, private maximum = 120000, private now = () => Date.now()) {}
  due() { return this.now() >= this.nextAt }
  succeeded(startedAt=this.now()) { this.failures = 0; this.nextAt = Math.max(this.now(), startedAt + this.interval) }
  failed() { this.failures = Math.min(this.failures + 1, 8); this.nextAt = this.now() + Math.min(this.maximum, this.interval * 2 ** this.failures) }
  reset() { this.nextAt = 0; this.failures = 0 }
}
