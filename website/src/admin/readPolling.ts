/** Automatic reads wait after completion, including failures. Manual reads bypass
 * the delay; callers still coalesce in-flight work and keep verified snapshots. */
export class ReadPolling {
  private nextAt = 0
  private failures = 0
  constructor(private interval: number, private maximum = 120000, private now = () => Date.now()) {}
  due() { return this.now() >= this.nextAt }
  succeeded() { this.failures = 0; this.nextAt = this.now() + this.interval }
  failed() { this.failures = Math.min(this.failures + 1, 8); this.nextAt = this.now() + Math.min(this.maximum, this.interval * 2 ** this.failures) }
  reset() { this.nextAt = 0; this.failures = 0 }
}
