/** A failed save must never schedule a later, surprising relaunch. */
export class RestartCoordinator {
  private work?: Promise<void>
  constructor(private prepare: () => Promise<void>, private commit: () => void) {}
  run(): Promise<void> {
    if (this.work) return this.work
    this.work = Promise.resolve().then(this.prepare).then(this.commit).catch(error => {
      this.work = undefined
      throw error
    })
    return this.work
  }
}
