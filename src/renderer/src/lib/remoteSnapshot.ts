/** Coalesce refreshes and preserve the last confirmed value while offline. */
export class RemoteSnapshot<T> {
  private value: T | null = null
  private generation = 0
  private pending?: Promise<void>
  constructor(private readonly changed: (value: T | null, synced: boolean) => void) {}
  accept(value: T): void { this.value = value; this.generation++; this.changed(value, true) }
  invalidate(fetchValue: () => Promise<T>): Promise<void> {
    this.generation++
    this.changed(this.value, false)
    if (this.pending) {
      this.trailing = fetchValue
      return this.pending
    }
    return this.refresh(fetchValue)
  }
  private trailing?: () => Promise<T>
  refresh(fetchValue: () => Promise<T>): Promise<void> {
    if (this.pending) return this.pending
    const generation = this.generation
    this.pending = Promise.resolve().then(fetchValue).then(value => {
      if (generation === this.generation) this.accept(value)
    }, () => {
      if (generation === this.generation) this.changed(this.value, false)
    }).finally(() => {
      this.pending = undefined
      const next = this.trailing; this.trailing = undefined
      if (next) return this.refresh(next)
    })
    return this.pending
  }
}
